import { rmSync } from 'node:fs'
import { shellName } from '../../../shared/terminal/terminalShell'
import type { PtyAttachResult } from '../../../shared/types'
import type { AppLog } from '../../diagnostics/appLog'
import type { Telemetry } from '../../diagnostics/telemetry'
import type { PaneProcess } from '../../panes/paneProcess'
import { hiddenHomeNotice } from '../../sandbox/spawnBanner'
import type { WorkspaceSandboxes } from '../../sandbox/workspaceSandboxes'
import { keepShellsNotice } from '../../tmux/keepShellsBanner'
import type { KeptMeta } from '../../tmux/keptShells'
import type { KeptShells } from '../../tmux/keptShells'
import type { TmuxPane } from '../../tmux/tmuxServer'
import { takeRestoredScrollback } from '../../workspaces/workspaceSnapshot'
import type { Subscriber } from '../ptySession'
import { HIBERNATE_SEAM, RESTORE_SEAM } from '../screenMirror'
import { PTY_TERM_NAME } from '../terminalType'
import { type PtyEntry, type PtyRegistry, feedDisplay, replayRestored } from './ptyRegistry'
import type { SpawnPlan } from './ptySpawnPlan'

interface PtyStartDeps {
  keptShells: KeptShells
  workspaceSandboxes: WorkspaceSandboxes
  hibernatedPanes: Set<string>
  trackPty: PtyRegistry['trackPty']
  feedPty: PtyRegistry['feedPty']
  releaseMergedSandbox: (workspaceId: string, exiting?: PtyEntry) => void
  telemetry: () => Telemetry | null
  appLog: () => AppLog | null
}

export type PtyStart = ReturnType<typeof createPtyStart>

export function createPtyStart({
  keptShells,
  workspaceSandboxes,
  hibernatedPanes,
  trackPty,
  feedPty,
  releaseMergedSandbox,
  telemetry,
  appLog,
}: PtyStartDeps) {
  function startTracked(
    e: Electron.IpcMainInvokeEvent,
    paneId: string,
    mod: typeof import('node-pty'),
    plan: SpawnPlan,
    { kept, keptMeta }: { kept: TmuxPane | null; keptMeta: KeptMeta | null },
    mkSub: (entry: PtyEntry) => Subscriber,
  ): PtyAttachResult {
    const subId = String(e.sender.id)
    const {
      workspaceId,
      shell,
      cols,
      rows,
      stateFile,
      markNonce,
      env,
      secretNotice,
      sandboxStamp,
      resizePipe,
      portBridge,
      file,
      args,
      folder,
      cwd,
      host,
      sandboxed,
      notKept,
      tokenFile,
    } = plan
    const pty: PaneProcess =
      kept ??
      mod.spawn(file, args, {
        name: PTY_TERM_NAME,
        cols,
        rows,
        cwd,
        env,
      })
    const entry = trackPty(paneId, pty, {
      kept,
      keptMeta,
      cols,
      rows,
      subs: new Map([[subId, e.sender]]),
      spawnPath: env.PATH ?? '',
      stateFile,
      markNonce,
      keepAlive: false,
      workspaceId,
      sandboxed,
      shell,
      sandboxStamp,
      portBridge,
    })
    const { session } = entry
    if (tokenFile) entry.exitListeners.add(() => keptShells.removeToken(paneId))
    if (sandboxed) {
      entry.exitListeners.add(() => {
        if (resizePipe) rmSync(resizePipe, { force: true })
        portBridge?.close()
        void workspaceSandboxes.cleanup(workspaceId)
        releaseMergedSandbox(workspaceId, entry)
      })
    }

    const history = takeRestoredScrollback(paneId)
    if (history) appLog()?.info('scrollback-replay', { pane: paneId, chars: history.length })
    const seam = hibernatedPanes.delete(paneId) ? HIBERNATE_SEAM : RESTORE_SEAM
    if (history) replayRestored(entry, history, seam)
    if (secretNotice) feedDisplay(entry, secretNotice)
    if (notKept) feedDisplay(entry, keepShellsNotice(notKept))
    if (sandboxed && workspaceSandboxes.claimHomeNotice(workspaceId)) {
      const notice = hiddenHomeNotice()
      if (notice) feedDisplay(entry, notice)
    }

    pty.onData((d) => feedPty(entry, d))
    pty.onExit(({ exitCode }) => session.exit(exitCode))
    const { data, cursor, dropped } = session.since(0)
    session.addLiveSubscriber(mkSub(entry))
    if (folder.missing) telemetry()?.count('terminal', 'spawn_failure', 'cwd-missing')
    return {
      created: true,
      buffer: data,
      cursor,
      dropped,
      shell: shellName(shell) || undefined,
      sandboxed,
      host,
      ...(sandboxStamp ? { sandboxStamp } : {}),
      ...(kept ? { kept: true } : {}),
      ...(folder.missing ? { cwdMissing: true } : {}),
      ...(markNonce ? { markNonce } : {}),
    }
  }

  return { startTracked }
}
