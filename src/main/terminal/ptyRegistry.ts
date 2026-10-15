import { rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { isHostNamed } from '../../shared/terminal/osc7'
import type { PaneActivity, TerminalStateSnapshot } from '../../shared/types'
import type { AgentRunningPanes } from '../agents/agentRunning'
import type { ReportedAgentWork } from '../agents/agentWork'
import type { OpenWaits } from '../files/openWaits'
import type { MirrorHandle, MirrorSink } from '../manager/portal'
import { type PaneIo, pastedText } from '../panes/paneIo'
import type { PaneProcess } from '../panes/paneProcess'
import type { PaneWaking } from '../panes/paneWaking'
import type { PortBridge } from '../sandbox/portBridge'
import type { SandboxReadRules } from '../sandbox/visibility'
import type { KeptAttention } from '../tmux/keptAttention'
import type { KeptMeta } from '../tmux/keptShells'
import type { TmuxPane } from '../tmux/tmuxServer'
import { stashScrollback } from '../workspaces/workspaceSnapshot'
import { atLocalPrompt, busyProgram } from './localPrompt'
import { PtyFlowControl } from './ptyFlow'
import type { ReapReason } from './ptyReaper'
import { PtySession } from './ptySession'
import { HISTORY_LINES, ScreenMirror } from './screenMirror'
import { closesPaneOnExit } from './shellExit'
import type { PaneOutput } from './terminalPathLinks'

import type { AppLog } from '../diagnostics/appLog'
import type { Telemetry } from '../diagnostics/telemetry'
import type { ProcessRegistry } from '../panes/processRegistry'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { KeptShells } from '../tmux/keptShells'

export interface PaneTitleEntry {
  paneId: string
  title: string
}

export interface PtyEntry {
  paneId: string
  pty: PaneProcess
  kept: TmuxPane | null
  keptMeta: KeptMeta | null
  session: PtySession
  flow: PtyFlowControl
  mirror: ScreenMirror
  subs: Map<string, Electron.WebContents>
  killTimer: ReturnType<typeof setTimeout> | null
  spawnPath: string
  stateFile: string
  workspaceId: string
  sandboxed: boolean
  shell: string
  sandboxStamp: string | null
  portBridge: PortBridge | null
  confinedBy: string | null
  keepAlive: boolean
  exitListeners: Set<(code: number) => void>
}

interface PtyRegistryDeps {
  ptys: Map<string, PtyEntry>
  movingPanes: Set<string>
  recoveryHeld: Set<string>
  closedPanes: Set<string>
  hibernatedPanes: Set<string>
  startedAgents: Set<string>
  terminalState: Map<string, TerminalStateSnapshot>
  keptShells: KeptShells
  workspaceSandboxes: WorkspaceSandboxes
  openWaits: OpenWaits
  agentRunning: AgentRunningPanes
  agentWork: ReportedAgentWork
  keptAttention: KeptAttention
  paneWaking: PaneWaking
  scheduleReap: (paneId: string, entry: PtyEntry) => void
  processes: () => ProcessRegistry | null
  telemetry: () => Telemetry | null
  appLog: () => AppLog | null
}

export function createPtyRegistry({
  ptys,
  movingPanes,
  recoveryHeld,
  closedPanes,
  hibernatedPanes,
  startedAgents,
  terminalState,
  keptShells,
  workspaceSandboxes,
  openWaits,
  agentRunning,
  agentWork,
  keptAttention,
  paneWaking,
  scheduleReap,
  processes,
  telemetry,
  appLog,
}: PtyRegistryDeps) {
  let ptyModule: typeof import('node-pty') | null | undefined
  function loadPty(): typeof import('node-pty') | null {
    if (ptyModule === undefined) {
      try {
        ptyModule = require('node-pty')
      } catch (err) {
        console.error('[pty] node-pty unavailable — terminals disabled. Run: npm run rebuild', err)
        ptyModule = null
      }
    }
    return ptyModule ?? null
  }

  const PTY_BUFFER_CAP = 1_000_000

  function holdsLocalPrompt(entry: PtyEntry): boolean {
    return atLocalPrompt({
      foreground: entry.pty.process,
      shell: entry.shell,
      sandboxed: entry.sandboxed,
    })
  }

  function paneActivity(entry: PtyEntry): PaneActivity {
    let program: string | null = null
    try {
      program = busyProgram({
        foreground: entry.pty.process,
        shell: entry.shell,
        sandboxed: entry.sandboxed,
      })
    } catch {
      program = null
    }
    return { program, agentRunning: agentRunning.has(entry.paneId) }
  }

  function sandboxReadRules(entry: PtyEntry): SandboxReadRules | null {
    if (!entry.sandboxed) return null
    try {
      const { denyRead, allowRead } = workspaceSandboxes.config(entry.workspaceId).filesystem
      return { denyRead, allowRead }
    } catch {
      return { denyRead: ['/'], allowRead: [] }
    }
  }

  function removeStateFile(entry: PtyEntry): void {
    rmSync(entry.stateFile, { force: true })
  }

  function killPty(paneId: string, reason: ReapReason): void {
    const entry = ptys.get(paneId)
    if (!entry) return
    appLog()?.info('pty-reap', { pane: paneId, reason })
    recoveryHeld.delete(paneId)
    closedPanes.delete(paneId)
    startedAgents.delete(paneId)
    if (entry.killTimer) clearTimeout(entry.killTimer)
    try {
      entry.pty.kill()
    } catch {}
    entry.flow.dispose()
    entry.mirror.dispose()
    removeStateFile(entry)
    keptShells.removeToken(paneId)
    ptys.delete(paneId)
    agentWork.clear(paneId)
  }

  function hibernatePty(paneId: string): boolean {
    const entry = ptys.get(paneId)
    if (!entry) return false
    telemetry()?.count('agents', 'hibernation')
    stashScrollback(paneId, entry.mirror.serialize())
    hibernatedPanes.add(paneId)
    paneWaking.end(paneId, 'failed')
    entry.subs.clear()
    killPty(paneId, 'hibernated')
    terminalState.delete(paneId)
    return true
  }

  function ptyPid(paneId: string): number | undefined {
    return ptys.get(paneId)?.pty.pid
  }

  async function paneOutput(paneId: string): Promise<PaneOutput | null> {
    const entry = ptys.get(paneId)
    if (!entry) return null
    const text = await entry.mirror.screenText(HISTORY_LINES)
    const report = entry.mirror.cwdReport
    const remote = report !== null && !isHostNamed(report.host, hostname())
    return { text, cwd: report?.path ?? null, remote }
  }

  function feedPty(entry: PtyEntry, data: string): void {
    entry.session.push(data)
    entry.mirror.write(data)
    processes()?.feed(entry.paneId, data, entry.session.cursor)
  }

  const paneIo: PaneIo = {
    read: async (paneId, lines) => {
      const entry = ptys.get(paneId)
      return entry ? entry.mirror.screenText(lines) : null
    },
    write: (paneId, data) => {
      const entry = ptys.get(paneId)
      if (!entry) return false
      const pasted = entry.kept ? pastedText(data) : null
      if (entry.kept && pasted !== null) entry.kept.paste(pasted)
      else entry.pty.write(data)
      return true
    },
    bracketedPaste: (paneId) => {
      const entry = ptys.get(paneId)
      if (!entry) return false
      return entry.kept !== null || entry.mirror.bracketedPaste
    },
    outputCursor: (paneId) => ptys.get(paneId)?.session.cursor,
  }

  function pausePty(entry: PtyEntry, paused: boolean): void {
    try {
      if (paused) entry.pty.pause?.()
      else entry.pty.resume?.()
    } catch {}
  }

  function releasePtyFlow(subId: string): void {
    for (const entry of ptys.values()) entry.flow.release(subId)
  }

  function hidePtyFlow(wid: string): void {
    for (const entry of ptys.values()) entry.flow.hidden(wid)
  }

  function resizePty(entry: PtyEntry | undefined, cols: number, rows: number): void {
    if (!entry) return
    const c = cols || 80
    const r = rows || 24
    try {
      entry.pty.resize(c, r)
    } catch {
      return
    }
    entry.mirror.resize(c, r)
  }

  function trackPty(
    paneId: string,
    pty: PaneProcess,
    opts: {
      cols: number
      rows: number
      subs: Map<string, Electron.WebContents>
      spawnPath: string
      stateFile: string
      keepAlive: boolean
      workspaceId?: string
      sandboxed?: boolean
      shell?: string
      sandboxStamp?: string | null
      portBridge?: PortBridge | null
      kept?: TmuxPane | null
      keptMeta?: KeptMeta | null
    },
  ): PtyEntry {
    const spawnedAt = Date.now()
    const session = new PtySession({
      capBytes: PTY_BUFFER_CAP,
      onNoOwners: () => {
        if (
          ptys.get(paneId) !== entry ||
          entry.killTimer ||
          entry.keepAlive ||
          movingPanes.has(paneId)
        ) {
          return
        }
        scheduleReap(paneId, entry)
      },
      onExit: (code) => {
        appLog()?.info('pty-exit', { pane: paneId, code })
        if (entry.killTimer) clearTimeout(entry.killTimer)
        entry.killTimer = null
        const closes = closesPaneOnExit({
          ownExit: ptys.get(paneId) === entry,
          code,
          livedMs: Date.now() - spawnedAt,
        })
        for (const wc of entry.subs.values()) {
          if (!wc.isDestroyed()) wc.send(`pty:exit:${paneId}`, code, closes)
        }
        for (const listener of entry.exitListeners) listener(code)
        processes()?.shellEnded(paneId, (from) => session.since(from))
        entry.flow.dispose()
        entry.mirror.dispose()
        removeStateFile(entry)
        if (ptys.get(paneId) === entry) {
          ptys.delete(paneId)
          openWaits.callerExited(paneId)
          movingPanes.delete(paneId)
          agentRunning.shellEnded(paneId)
          agentWork.clear(paneId)
          keptAttention.reported(paneId)
          recoveryHeld.delete(paneId)
          closedPanes.delete(paneId)
        }
      },
    })
    const entry: PtyEntry = {
      paneId,
      pty,
      session,
      flow: new PtyFlowControl({
        pause: () => pausePty(entry, true),
        resume: () => pausePty(entry, false),
      }),
      mirror: new ScreenMirror(opts.cols, opts.rows),
      subs: opts.subs,
      killTimer: null,
      spawnPath: opts.spawnPath,
      stateFile: opts.stateFile,
      keepAlive: opts.keepAlive,
      exitListeners: new Set(),
      workspaceId: opts.workspaceId ?? '',
      sandboxed: opts.sandboxed ?? false,
      shell: opts.shell ?? '',
      sandboxStamp: opts.sandboxStamp ?? null,
      portBridge: opts.portBridge ?? null,
      confinedBy: opts.sandboxed ? (opts.workspaceId ?? '') : null,
      kept: opts.kept ?? null,
      keptMeta: opts.keptMeta ?? null,
    }
    ptys.set(paneId, entry)
    return entry
  }

  const MIRROR_SUBSCRIBER = 'portal-mirror'

  function attachMirror(paneId: string, sink: MirrorSink): MirrorHandle | null {
    const entry = ptys.get(paneId)
    if (!entry) return null
    const onExit = (code: number): void => sink.exit(code)
    entry.exitListeners.add(onExit)
    entry.session.addSubscriber(
      { id: MIRROR_SUBSCRIBER, role: 'owner', send: (data) => sink.data(data) },
      0,
    )
    return {
      write: (data) => {
        if (ptys.get(paneId) === entry) entry.pty.write(data)
      },
      resize: (cols, rows) => {
        if (ptys.get(paneId) !== entry) return
        if (entry.pty.cols === cols && entry.pty.rows === rows) return
        resizePty(entry, cols, rows)
        for (const wc of entry.subs.values()) {
          if (!wc.isDestroyed()) wc.send(`pty:size:${paneId}`, cols, rows)
        }
      },
      detach: () => {
        entry.exitListeners.delete(onExit)
        entry.session.removeSubscriber(MIRROR_SUBSCRIBER)
      },
    }
  }

  function ptyResize(rendererPaneId: string, cols: number, rows: number): void {
    resizePty(ptys.get(rendererPaneId), cols, rows)
  }

  function ptyWrite(rendererPaneId: string, data: string): void {
    ptys.get(rendererPaneId)?.pty.write(data)
  }

  return {
    loadPty,
    holdsLocalPrompt,
    paneActivity,
    sandboxReadRules,
    removeStateFile,
    killPty,
    hibernatePty,
    ptyPid,
    paneOutput,
    feedPty,
    paneIo,
    releasePtyFlow,
    hidePtyFlow,
    resizePty,
    trackPty,
    attachMirror,
    ptyResize,
    ptyWrite,
  }
}
