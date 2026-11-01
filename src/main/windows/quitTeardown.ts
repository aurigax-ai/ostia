import type { QuitAnswer } from '../../shared/windows/windowsApi'
import type { ArtifactFolders } from '../artifacts/artifactFolders'
import type { ArtifactHistory } from '../artifacts/artifactHistory'
import type { PreviewHost } from '../artifacts/htmlPreview'
import type { McpHost } from '../chat/mcpHost'
import type { McpOAuth } from '../chat/mcpOAuth'
import { clearControlInfo, controlInfoPath } from '../control/controlDiscovery'
import { controlSocketPath, stopControlServer } from '../control/controlServer'
import type { AppLog } from '../diagnostics/appLog'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { TreeWatches } from '../files/fileWatch'
import { stopGateway } from '../gateway/server'
import type { GitService } from '../git/service'
import type { LanguageServers } from '../lsp/languageServers'
import type { ManagerService } from '../manager/manager'
import type { Portal } from '../manager/portal'
import { saveJson } from '../platform/jsonStore'
import type { PortsService } from '../ports/service'
import type { ProfileSyncHandle } from '../profileSync/ipc'
import type { PortForwarder, SandboxListener } from '../sandbox/ports/portForwarder'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { WorkspaceAgents } from '../secrets/workspaceAgents'
import { type PaneHistories, removeHistories } from '../terminal/history/paneHistories'
import { type PtyEntry, removeStateFile } from '../terminal/pty/ptyRegistry'
import type { KeptHostMeta } from '../tmux/keptShells'
import type { KeptShellsWiring } from '../tmux/keptShellsWiring'
import type { TmuxPane } from '../tmux/tmuxPane'
import type { PendingSweep } from '../updates/installReplace'
import type { SignaturePolicy } from '../updates/macReplace'
import { swapStagedBundle, verifyStagedSync } from '../updates/macReplace'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import type { ViewHost } from '../workspaces/viewHost'
import type { GlobalHotkey } from './globalHotkey'
import type { QuitTrace } from './quitPlan'
import { keepsShellsOnQuit } from './quitPlan'
import type { AppTray } from './tray'
import type { WindowBroker } from './windowBroker'

interface QuitTeardownDeps {
  quitTrace: QuitTrace
  services: {
    appLog: AppLog | null
    histories: PaneHistories | null
    appTray: AppTray | null
    broker: WindowBroker | null
    extensionHost: ExtensionHost | null
    gitService: GitService | null
    globalHotkey: GlobalHotkey | null
    languageServers: LanguageServers | null
    managerService: ManagerService | null
    mcpHost: McpHost | null
    mcpOAuth: McpOAuth | null
    portal: Portal | null
    portsService: PortsService | null
    profileSync: ProfileSyncHandle | null
    stopAnnouncing: (() => void) | null
    stopRemote: (() => Promise<void>) | null
    viewHost: ViewHost | null
  }
  ptys: Map<string, PtyEntry>
  quit: {
    restartRequested: boolean
    stagedUpdate: { pending: PendingSweep; sweepFile: string } | null
  }
  keptHostPanes: Map<string, { pane: TmuxPane; meta: KeptHostMeta }>
  syncKeptExposed: (workspaceId: string, listening?: readonly SandboxListener[]) => void
  portForwarder: PortForwarder
  keptShells: KeptShellsWiring['keptShells']
  languageServerWatches: TreeWatches
  workspaceSandboxes: WorkspaceSandboxes
  workspaceAgents: WorkspaceAgents
  scratchFolders: ScratchFolders
  artifactFolders: ArtifactFolders
  artifactHistory: ArtifactHistory
  previews: PreviewHost
  updatePolicy: SignaturePolicy
}

export type QuitTeardown = ReturnType<typeof createQuitTeardown>

export function createQuitTeardown({
  quitTrace,
  services,
  ptys,
  quit,
  keptHostPanes,
  syncKeptExposed,
  portForwarder,
  keptShells,
  languageServerWatches,
  workspaceSandboxes,
  workspaceAgents,
  scratchFolders,
  artifactFolders,
  artifactHistory,
  previews,
  updatePolicy,
}: QuitTeardownDeps) {
  async function teardown(quitAnswer: QuitAnswer | null): Promise<void> {
    quitTrace.stage('teardown-windows')
    services.broker?.persist()
    services.managerService?.shutdown()
    services.appLog?.info('app-quit', { ptys: ptys.size })
    const keepingShells = keepsShellsOnQuit(quit.restartRequested, quitAnswer)
    services.appLog?.info('quit-kept-shells', {
      keep: keepingShells ? 1 : 0,
      restart: quit.restartRequested ? 1 : 0,
    })
    if (keepingShells) {
      for (const workspaceId of keptHostPanes.keys()) {
        syncKeptExposed(workspaceId, portForwarder.listeners(workspaceId))
      }
    }
    quitTrace.stage('teardown-ptys')
    await removeHistories(services.histories, services.appLog)
    for (const entry of ptys.values()) {
      entry.mirror.dispose()
      if (keepingShells && entry.kept) {
        entry.kept.detach()
        entry.portBridge?.close()
        continue
      }
      try {
        entry.pty.kill()
      } catch {}
      removeStateFile(entry)
    }
    ptys.clear()
    quitTrace.stage('teardown-kept-shells')
    if (keepingShells) keptShells.release()
    else keptShells.quitNow()
    quitTrace.stage('teardown-language-servers')
    services.languageServers?.stopAll()
    languageServerWatches.closeAll()
    quitTrace.stage('teardown-sandboxes')
    if (keepingShells) workspaceSandboxes.hosts.releaseAll()
    else workspaceSandboxes.hosts.stopAll()
    workspaceAgents.stopAll()
    for (const workspaceId of scratchFolders.workspaceIds()) workspaceSandboxes.forget(workspaceId)
    workspaceSandboxes.tmp.clearTmp(!keepingShells)
    artifactFolders.dispose()
    artifactHistory.quit()
    artifactHistory.dispose()
    previews.dispose()
    const stuckScratch = await scratchFolders.removeAll()
    if (stuckScratch.length > 0) {
      services.appLog?.warn('scratch-remove-failed', {
        folders: stuckScratch.length,
        codes: [...new Set(stuckScratch.map((f) => f.code))].join(','),
      })
    }
    quitTrace.stage('teardown-hosts')
    portForwarder.stopAll()
    services.gitService?.stop()
    services.portsService?.stop()
    await services.extensionHost?.processes.stopAll()
    services.mcpOAuth?.closeAll()
    services.mcpHost?.closeAll()
    services.viewHost?.stop()
    services.profileSync?.stop()
    quitTrace.stage('teardown-network')
    stopControlServer()
    clearControlInfo(controlInfoPath(), controlSocketPath())
    services.portal?.stop()
    void services.stopRemote?.()
    services.stopAnnouncing?.()
    void stopGateway()
    services.appTray?.remove()
    services.globalHotkey?.clear()
    if (quit.stagedUpdate) {
      quitTrace.stage('update-swap')
      const { pending, sweepFile } = quit.stagedUpdate
      quit.stagedUpdate = null
      const result = swapStagedBundle(pending.appDir, {
        verify: (staged) => verifyStagedSync(staged, updatePolicy),
      })
      services.appLog?.info('update-swap', { version: pending.version, result })
      if (result === 'swapped') saveJson(sweepFile, pending)
    }
    quitTrace.stage('teardown-done')
  }

  return { teardown }
}
