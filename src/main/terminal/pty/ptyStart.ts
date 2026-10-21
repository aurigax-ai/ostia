import { rmSync } from 'node:fs'
import type { PtyAttachResult } from '../../../shared/terminal/ptyApi'
import { shellName } from '../../../shared/terminal/terminalShell'
import type { AppLog } from '../../diagnostics/appLog'
import type { Telemetry } from '../../diagnostics/telemetry'
import type { PaneLifecycleEvents } from '../../extensions/paneLifecycleEvents'
import type { PaneProcess } from '../../panes/paneProcess'
import { hiddenHomeNotice } from '../../sandbox/spawnBanner'
import type { WorkspaceSandboxes } from '../../sandbox/workspaceSandboxes'
import { keepShellsNotice } from '../../tmux/keepShellsBanner'
import type { KeptMeta, KeptShells } from '../../tmux/keptShells'
import type { TmuxPane } from '../../tmux/tmuxPane'
import { takeRestoredScrollback } from '../../workspaces/savedScrollback'
import type { PaneBannerText } from '../paneBanner'
import type { Subscriber } from '../ptySession'
import { hibernateSeam, restoreSeam } from '../screenMirror'
import { PTY_TERM_NAME } from '../terminalType'
import { feedDisplay, type PtyEntry, type PtyRegistry, replayRestored } from './ptyRegistry'
import type { SpawnPlan } from './ptySpawnPlan'

interface PtyStartDeps {
  keptShells: KeptShells
  workspaceSandboxes: WorkspaceSandboxes
  hibernatedPanes: Set<string>
  paneLifecycleEvents: PaneLifecycleEvents
  trackPty: PtyRegistry['trackPty']
  feedPty: PtyRegistry['feedPty']
  releaseMergedSandbox: (workspaceId: string, exiting?: PtyEntry) => void
  telemetry: () => Telemetry | null
  appLog: () => AppLog | null
  bannerText: () => PaneBannerText
}

export type PtyStart = ReturnType<typeof createPtyStart>

export function createPtyStart({
  keptShells,
  workspaceSandboxes,
  hibernatedPanes,
  paneLifecycleEvents,
  trackPty,
  feedPty,
  releaseMergedSandbox,
  telemetry,
  appLog,
  bannerText,
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
      integrationNotice,
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
        void workspaceSandboxes.hosts.cleanup(workspaceId)
        releaseMergedSandbox(workspaceId, entry)
      })
    }

    const history = takeRestoredScrollback(paneId)
    if (history) appLog()?.info('scrollback-replay', { pane: paneId, chars: history.length })
    const woken = hibernatedPanes.delete(paneId)
    if (woken) paneLifecycleEvents.change(paneId, 'woken')
    const seam = woken ? hibernateSeam(bannerText()) : restoreSeam(bannerText())
    if (history) replayRestored(entry, history, seam)
    if (secretNotice) feedDisplay(entry, secretNotice)
    if (integrationNotice) feedDisplay(entry, integrationNotice)
    if (notKept) feedDisplay(entry, keepShellsNotice(bannerText(), notKept))
    if (sandboxed && workspaceSandboxes.claimHomeNotice(workspaceId)) {
      const notice = hiddenHomeNotice(bannerText())
      if (notice) feedDisplay(entry, notice)
    }

    pty.onData((d) => feedPty(entry, d))
    pty.onExit(({ exitCode }) => session.exit(exitCode))
    const { data, cursor, dropped, startsBefore } = session.since(0)
    session.addLiveSubscriber(mkSub(entry))
    if (folder.missing) telemetry()?.count('terminal', 'spawn_failure', 'cwd-missing')
    return {
      created: true,
      buffer: data,
      cursor,
      dropped,
      blockSeqBase: entry.mirror.blockSeqBase + startsBefore,
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
