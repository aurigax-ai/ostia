import { BrowserWindow, app } from 'electron'
import type { Dict } from '../../shared/app/dict'
import type { QuitAnswer } from '../../shared/types'
import type { PaneActivity } from '../../shared/types'
import type { ScriptTokenUsageLog } from '../approvals/scriptTokenUsage'
import type { ArtifactFolders } from '../artifacts/artifactFolders'
import type { ArtifactHistory } from '../artifacts/artifactHistory'
import type { PreviewHost } from '../artifacts/htmlPreview'
import type { McpHost } from '../chat/mcpHost'
import type { McpOAuth } from '../chat/mcpOAuth'
import { clearControlInfo, controlInfoPath } from '../control/controlDiscovery'
import { controlSocketPath, stopControlServer } from '../control/controlServer'
import type { AppLog } from '../diagnostics/appLog'
import type { Telemetry } from '../diagnostics/telemetry'
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
import type { PortForwarder } from '../sandbox/portForwarder'
import type { SandboxListener } from '../sandbox/portForwarder'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { WorkspaceAgents } from '../secrets/workspaceAgents'
import { type PtyEntry, removeStateFile } from '../terminal/pty/ptyRegistry'
import type { KeptHostMeta } from '../tmux/keptShells'
import type { KeptShells } from '../tmux/keptShells'
import type { TmuxPane } from '../tmux/tmuxServer'
import type { PendingSweep } from '../updates/installReplace'
import { swapStagedBundle, verifyStagedSync } from '../updates/macReplace'
import type { SignaturePolicy } from '../updates/macReplace'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import type { ViewHost } from '../workspaces/viewHost'
import { confirmQuit, freezeAll } from './closeGuard'
import type { GlobalHotkey } from './globalHotkey'
import {
  QUIT_SIGNALS,
  exitAfterDeadline,
  keepsShellsOnQuit,
  keptOnQuit,
  planQuit,
  summarizeKinds,
} from './quitPlan'
import type { QuitTrace } from './quitPlan'
import { nativeQuitConfirm } from './quitPrompt'
import type { AppTray } from './tray'
import type { WindowBroker } from './windowBroker'

interface AppQuitDeps {
  readSettingsFile: () => {
    locale?: unknown
    extensionSettings?: unknown
    git?: unknown
    ports?: unknown
    workspaces?: { globalHotkey?: unknown; confirmQuit?: unknown }
    manager?: unknown
    assistant?: unknown
    privacy?: unknown
    terminal?: { shell?: unknown; keepShells?: unknown }
    agents?: { hooks?: unknown }
    behavior?: { historySuggestions?: unknown }
  }
  services: {
    appLog: AppLog | null
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
    stopTailnet: (() => Promise<void>) | null
    telemetry: Telemetry | null
    viewHost: ViewHost | null
  }
  quitTrace: QuitTrace
  quit: {
    quitApproved: boolean
    restartRequested: boolean
    savingScrollbackForQuit: boolean
    scrollbackSavedForQuit: boolean
    stagedUpdate: { pending: PendingSweep; sweepFile: string } | null
  }
  windows: Map<string, BrowserWindow>
  ptys: Map<string, PtyEntry>
  mainWindow: () => BrowserWindow | undefined
  scratchFolders: ScratchFolders
  paneActivity: (entry: PtyEntry) => PaneActivity
  mainStrings: () => Dict
  persistScrollback: () => Promise<void>
  keptHostPanes: Map<string, { pane: TmuxPane; meta: KeptHostMeta }>
  syncKeptExposed: (workspaceId: string, listening?: readonly SandboxListener[]) => void
  portForwarder: PortForwarder
  keptShells: KeptShells
  languageServerWatches: TreeWatches
  workspaceSandboxes: WorkspaceSandboxes
  workspaceAgents: WorkspaceAgents
  artifactFolders: ArtifactFolders
  artifactHistory: ArtifactHistory
  previews: PreviewHost
  updatePolicy: SignaturePolicy
  scriptTokenUsage: ScriptTokenUsageLog
}

export function registerAppQuit({
  readSettingsFile,
  services,
  quitTrace,
  quit,
  windows,
  ptys,
  mainWindow,
  scratchFolders,
  paneActivity,
  mainStrings,
  persistScrollback,
  keptHostPanes,
  syncKeptExposed,
  portForwarder,
  keptShells,
  languageServerWatches,
  workspaceSandboxes,
  workspaceAgents,
  artifactFolders,
  artifactHistory,
  previews,
  updatePolicy,
  scriptTokenUsage,
}: AppQuitDeps) {
  let telemetrySentForQuit = false
  let sendingTelemetryForQuit = false
  let quitAnswer: QuitAnswer | null = null

  function confirmQuitOn(): boolean {
    return readSettingsFile().workspaces?.confirmQuit !== false
  }
  let quitAsking = false
  let quitRequested = false

  function requestQuit(): void {
    quitRequested = true
    app.quit()
  }
  let quitSignaled = false

  function handleQuitSignals(): void {
    for (const signal of QUIT_SIGNALS) {
      process.on(signal, () => {
        services.appLog?.info('quit-signal', { signal })
        quitSignaled = true
        app.quit()
      })
    }
  }

  function exitAtQuitDeadline(): void {
    services.appLog?.warn('quit-deadline', {
      stage: quitTrace.current(),
      totalMs: quitTrace.elapsedMs(),
      alive: summarizeKinds(process.getActiveResourcesInfo()),
    })
    app.exit(0)
  }

  function teardown(): void {
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
    if (keepingShells) workspaceSandboxes.releaseAll()
    else workspaceSandboxes.stopAll()
    workspaceAgents.stopAll()
    for (const workspaceId of scratchFolders.workspaceIds()) workspaceSandboxes.forget(workspaceId)
    workspaceSandboxes.clearTmp(!keepingShells)
    artifactFolders.dispose()
    artifactHistory.quit()
    artifactHistory.dispose()
    previews.dispose()
    scratchFolders.removeAll()
    quitTrace.stage('teardown-hosts')
    portForwarder.stopAll()
    services.gitService?.stop()
    services.portsService?.stop()
    services.extensionHost?.processes.stopAll()
    services.mcpOAuth?.closeAll()
    services.mcpHost?.closeAll()
    services.viewHost?.stop()
    services.profileSync?.stop()
    quitTrace.stage('teardown-network')
    stopControlServer()
    clearControlInfo(controlInfoPath(), controlSocketPath())
    services.portal?.stop()
    void services.stopTailnet?.()
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

  app.on('before-quit', (event) => {
    const plan = planQuit({
      approved: quit.quitApproved,
      requestedByOstia: quitRequested,
      signaled: quitSignaled,
      platform: process.platform,
    })
    quitRequested = false
    quitTrace.stage(`plan-${plan}`)
    if (plan === 'unattended') {
      quit.quitApproved = true
      freezeAll([...windows.values()])
      exitAfterDeadline(exitAtQuitDeadline)
    }
    if (plan === 'ask') {
      event.preventDefault()
      if (quitAsking) return
      quitAsking = true
      const all = [...windows.values()]
      const kept = keptOnQuit(
        quit.restartRequested,
        confirmQuitOn(),
        [...ptys.values()].map((entry) => ({ paneId: entry.paneId, kept: entry.kept !== null })),
      )
      void confirmQuit(all, BrowserWindow.getFocusedWindow() ?? mainWindow(), {
        scratchFiles: (workspaceId) => scratchFolders.countFiles(workspaceId),
        kept: kept.kept,
        keptShells: kept.offer,
        workspacesOf: (win) => services.broker?.workspacesOf(win) ?? [],
        processes: () =>
          [...ptys.values()].map((entry) => ({
            paneId: entry.paneId,
            workspaceId: entry.workspaceId,
            ...paneActivity(entry),
          })),
        confirmNative: nativeQuitConfirm(mainStrings),
      }).then((answer) => {
        quitAsking = false
        if (answer === 'cancel') {
          quit.restartRequested = false
          return
        }
        quitAnswer = answer
        quit.quitApproved = true
        freezeAll(all)
        app.quit()
      })
      return
    }
    if (!quit.scrollbackSavedForQuit) {
      event.preventDefault()
      if (quit.savingScrollbackForQuit) return
      quit.savingScrollbackForQuit = true
      quitTrace.stage('scrollback')
      void persistScrollback().finally(() => {
        quit.scrollbackSavedForQuit = true
        app.quit()
      })
      return
    }
    if (!telemetrySentForQuit) {
      event.preventDefault()
      if (sendingTelemetryForQuit) return
      sendingTelemetryForQuit = true
      quitTrace.stage('telemetry')
      void (services.telemetry?.shutdown() ?? Promise.resolve()).finally(() => {
        telemetrySentForQuit = true
        app.quit()
      })
      return
    }
    teardown()
  })

  app.on('will-quit', () => {
    quitTrace.stage('will-quit')
    scriptTokenUsage.close()
  })
  app.on('quit', () => quitTrace.stage('quit'))

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') requestQuit()
  })

  return { requestQuit, handleQuitSignals }
}
