import { rmSync } from 'node:fs'
import type { PtyAttachResult, PtySpawnOptions } from '../../shared/terminal/ptyApi'
import { shellName } from '../../shared/terminal/terminalShell'
import type { AgentRunningPanes } from '../agents/agentRunning'
import { adoptPane, type PaneIdentity } from '../control/idRegistry'
import type { AppLog } from '../diagnostics/appLog'
import type { ProcessRegistry } from '../panes/processRegistry'
import { PortBridge } from '../sandbox/ports/portBridge'
import type { PortRequests } from '../sandbox/ports/portRequests'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { PaneBannerText } from '../terminal/paneBanner'
import { feedDisplay, type PtyEntry, type PtyRegistry } from '../terminal/pty/ptyRegistry'
import type { Subscriber } from '../terminal/ptySession'
import { restoreSeam } from '../terminal/screenMirror'
import { retainAgentDir } from '../terminal/shellIntegration'
import { takeRestoredScrollback } from '../workspaces/savedScrollback'
import type { SavedAttention } from './attentionFile'
import type { KeptAttention } from './keptAttention'
import type { KeptPlumbing } from './keptLaunchers'
import type { KeptShell, KeptShells } from './keptShells'

interface KeptReattachDeps {
  workspaceSandboxes: WorkspaceSandboxes
  keptShells: KeptShells
  keptPlumbing: KeptPlumbing
  keptAttention: KeptAttention
  agentRunning: AgentRunningPanes
  hibernatedPanes: Set<string>
  portRequests: PortRequests
  trackPty: PtyRegistry['trackPty']
  feedPty: PtyRegistry['feedPty']
  releaseMergedSandbox: (workspaceId: string, exiting?: PtyEntry) => void
  restoreKeptAttention: (identity: PaneIdentity, saved: SavedAttention) => void
  processes: () => ProcessRegistry | null
  appLog: () => AppLog | null
  bannerText: () => PaneBannerText
}

export type KeptReattach = ReturnType<typeof createKeptReattach>

export function createKeptReattach({
  workspaceSandboxes,
  keptShells,
  keptPlumbing,
  keptAttention,
  agentRunning,
  hibernatedPanes,
  portRequests,
  trackPty,
  feedPty,
  releaseMergedSandbox,
  restoreKeptAttention,
  processes,
  appLog,
  bannerText,
}: KeptReattachDeps) {
  async function reattachKept(
    e: Electron.IpcMainInvokeEvent,
    paneId: string,
    opts: PtySpawnOptions,
    kept: KeptShell,
    mkSub: (entry: PtyEntry) => Subscriber,
  ): Promise<PtyAttachResult> {
    const subId = String(e.sender.id)
    const { pane, meta } = kept
    const identity = adoptPane({ windowId: subId, workspaceId: meta.workspaceId, paneId })
    if (identity.externalId !== meta.externalId) {
      appLog()?.info('kept-pane-id-changed', { pane: paneId })
    }
    keptPlumbing.ensure()
    const savedAttention = keptShells.savedAttention(paneId)
    keptShells.writeToken(paneId, identity.token)
    keptAttention.reattached(paneId, agentRunning.has(paneId))
    takeRestoredScrollback(paneId)
    hibernatedPanes.delete(paneId)
    const cols = opts.cols || pane.cols
    const rows = opts.rows || pane.rows
    const sandbox = meta.sandbox
    const workspaceId = meta.workspaceId
    const keptHost = sandbox ? keptShells.keptHost(workspaceId) : undefined
    if (keptHost) workspaceSandboxes.tmp.adoptKeptTmp(workspaceId, keptHost.tmpDir)
    const portBridge = sandbox?.bridgeId
      ? await PortBridge.open(
          workspaceSandboxes.tmp.tmpDir(workspaceId),
          undefined,
          sandbox.bridgeId,
        )
      : null
    const entry = trackPty(paneId, pane, {
      kept: pane,
      keptMeta: meta,
      cols,
      rows,
      subs: new Map([[subId, e.sender]]),
      spawnPath: meta.spawnPath,
      stateFile: meta.stateFile,
      markNonce: meta.markNonce ?? null,
      keepAlive: false,
      workspaceId,
      shell: meta.shell,
      sandboxed: sandbox !== undefined,
      sandboxStamp: sandbox?.stamp ?? null,
      portBridge,
    })
    if (sandbox) {
      entry.exitListeners.add(() => {
        if (sandbox.resizePipe) rmSync(sandbox.resizePipe, { force: true })
        portBridge?.close()
        void workspaceSandboxes.hosts.cleanup(workspaceId)
        releaseMergedSandbox(workspaceId, entry)
      })
      portRequests.keep(workspaceId, keptHost?.exposed ?? [])
      void workspaceSandboxes.hosts.connect(workspaceId).catch(() => undefined)
    }
    retainAgentDir(paneId, meta.agentDir)
    pane.onData((d) => feedPty(entry, d))
    pane.onExit(({ exitCode }) => entry.session.exit(exitCode))
    let screen = ''
    try {
      screen = await pane.snapshot(cols, rows)
    } catch {}
    feedDisplay(entry, restoreSeam(bannerText()))
    feedPty(entry, screen)
    const keptAgent = agentRunning.stillRunning(paneId, {
      foreground: await pane.currentCommand().catch(() => ''),
      shell: meta.shell,
      sandboxed: sandbox !== undefined,
    })
    if (meta.process) {
      processes()?.adopt(
        {
          ...meta.process,
          cwd: meta.process.cwd,
          workspaceId: meta.workspaceId,
          paneId,
          externalPaneId: identity.externalId,
        },
        entry.session.cursor,
      )
    }
    pane.live()
    const { data, cursor, dropped, startsBefore } = entry.session.since(0)
    entry.session.addLiveSubscriber(mkSub(entry))
    if (savedAttention) restoreKeptAttention(identity, savedAttention)
    return {
      created: false,
      buffer: data,
      cursor,
      dropped,
      blockSeqBase: entry.mirror.blockSeqBase + startsBefore,
      shell: shellName(meta.shell) || undefined,
      sandboxed: sandbox !== undefined,
      ...(sandbox?.stamp ? { sandboxStamp: sandbox.stamp } : {}),
      kept: true,
      reattached: true,
      ...(keptAgent ? { agentRunning: true } : {}),
      cols: pane.cols,
      rows: pane.rows,
      ...(meta.markNonce ? { markNonce: meta.markNonce } : {}),
    }
  }

  return { reattachKept }
}
