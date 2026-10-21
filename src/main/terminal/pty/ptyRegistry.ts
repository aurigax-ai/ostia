import { rmSync } from 'node:fs'
import type { AgentRunningPanes } from '../../agents/agentRunning'
import type { ReportedAgentWork } from '../../agents/agentWork'
import type { AppLog } from '../../diagnostics/appLog'
import type { OpenWaits } from '../../files/openWaits'
import { PaneInput } from '../../panes/paneInput'
import type { PaneProcess } from '../../panes/paneProcess'
import type { ProcessRegistry } from '../../panes/processRegistry'
import type { PortBridge } from '../../sandbox/ports/portBridge'
import type { KeptAttention } from '../../tmux/keptAttention'
import type { KeptMeta } from '../../tmux/keptShells'
import type { TmuxPane } from '../../tmux/tmuxPane'
import { SPILL_BACKLOG, type SpillPressure } from '../history/historyFeed'
import type { PaneHistories } from '../history/paneHistories'
import { markNonceFileFor } from '../markNonce'
import { PtyFlowControl } from '../ptyFlow'
import { PtySession } from '../ptySession'
import { ScreenMirror } from '../screenMirror'
import { closesPaneOnExit } from '../shellExit'
import { releaseAgentDir } from '../shellIntegration'
import { type PtyHold, releasePty } from './ptySize'

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
  input: PaneInput
  subs: Map<string, Electron.WebContents>
  killTimer: ReturnType<typeof setTimeout> | null
  spawnPath: string
  stateFile: string
  markNonce: string | null
  workspaceId: string
  sandboxed: boolean
  shell: string
  sandboxStamp: string | null
  portBridge: PortBridge | null
  confinedBy: string | null
  keepAlive: boolean
  exitListeners: Set<(code: number) => void>
  sizeListeners: Set<(cols: number, rows: number) => void>
  hold: PtyHold | null
}

export function removeStateFile(entry: PtyEntry): void {
  rmSync(entry.stateFile, { force: true })
  rmSync(markNonceFileFor(entry.stateFile), { force: true })
}

function pausePty(entry: PtyEntry, paused: boolean): void {
  try {
    if (paused) entry.pty.pause?.()
    else entry.pty.resume?.()
  } catch {}
}

const HISTORY_LANE = 'history'

function spillPressure(flow: PtyFlowControl, pty: PaneProcess): SpillPressure {
  const lane = flow.open(HISTORY_LANE, () => true, SPILL_BACKLOG)
  return {
    canPause: typeof pty.pause === 'function',
    hold: (chars) => lane.sent(chars),
    release: (chars) => flow.ack(HISTORY_LANE, chars),
    close: () => lane.close(),
  }
}

interface PtyRegistryDeps {
  ptys: Map<string, PtyEntry>
  movingPanes: Set<string>
  recoveryHeld: Set<string>
  closedPanes: Set<string>
  scheduleReap: (paneId: string, entry: PtyEntry) => void
  openWaits: OpenWaits
  agentRunning: AgentRunningPanes
  agentWork: ReportedAgentWork
  keptAttention: KeptAttention
  processes: () => ProcessRegistry | null
  appLog: () => AppLog | null
  histories: () => PaneHistories | null
}

export type PtyRegistry = ReturnType<typeof createPtyRegistry>

export function feedDisplay(entry: Pick<PtyEntry, 'session'>, data: string): void {
  entry.session.push(data)
}

export function replayRestored(
  entry: Pick<PtyEntry, 'session' | 'mirror'>,
  history: string,
  seam: string,
): void {
  feedDisplay(entry, `${history}${seam}`)
  entry.mirror.restore(history)
}

export function createPtyRegistry({
  ptys,
  movingPanes,
  recoveryHeld,
  closedPanes,
  scheduleReap,
  openWaits,
  agentRunning,
  agentWork,
  keptAttention,
  processes,
  appLog,
  histories,
}: PtyRegistryDeps) {
  let ptyModule: typeof import('node-pty') | null | undefined

  function loadPty(): typeof import('node-pty') | null {
    if (ptyModule === undefined) {
      try {
        ptyModule = require('node-pty')
      } catch (err) {
        console.error('[pty] node-pty unavailable — terminals disabled. Run: pnpm rebuild', err)
        ptyModule = null
      }
    }
    return ptyModule ?? null
  }

  const PTY_BUFFER_CAP = 1_000_000

  function feedPty(entry: PtyEntry, data: string): void {
    entry.session.push(data)
    entry.mirror.write(data)
    processes()?.feed(entry.paneId, data, entry.session.cursor)
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
      markNonce?: string | null
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
        releasePty(paneId, entry)
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
          releaseAgentDir(paneId)
        }
      },
    })
    const flow = new PtyFlowControl({
      pause: () => pausePty(entry, true),
      resume: () => pausePty(entry, false),
    })
    const feed = histories()?.feedFor(paneId, opts.cols, opts.rows, spillPressure(flow, pty))
    const entry: PtyEntry = {
      paneId,
      pty,
      session,
      flow,
      mirror: new ScreenMirror(opts.cols, opts.rows, feed ?? null),
      input: new PaneInput(Date.now),
      subs: opts.subs,
      killTimer: null,
      spawnPath: opts.spawnPath,
      stateFile: opts.stateFile,
      markNonce: opts.markNonce ?? null,
      keepAlive: opts.keepAlive,
      exitListeners: new Set(),
      sizeListeners: new Set(),
      hold: null,
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

  return { loadPty, feedPty, trackPty }
}
