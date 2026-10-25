import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import './assets/fonts/hack-nerd-font.css'
import './assets/fonts/meslo-nerd-font.css'
import 'allotment/dist/style.css'
import './index.css'
import './findHighlight.css'

import { watchScrolling } from '@aurigax-ai/ostia-extension-sdk/contract/scrollbar'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppErrorBoundary, CrashTestHook, RecoveryScreen } from '@/components/app/AppErrorBoundary'
import { startActivationResume } from '@/lib/agents/activationResume'
import { startAgentRunningReport } from '@/lib/agents/agentRunningReport'
import { startAutoResume } from '@/lib/agents/autoResume'
import { startHibernation } from '@/lib/agents/hibernationScheduler'
import { startAgentDetection } from '@/lib/agents/paneAgent'
import { startAppMenu } from '@/lib/app/appMenu'
import { loadDesktops } from '@/lib/app/desktop'
import { errorDetails, reportError, startErrorReporting } from '@/lib/app/errorReporting'
import { startFocusModality } from '@/lib/app/focusModality'
import { startCtrlTracking } from '@/lib/app/wheelZoom'
import { startShortcutReporting } from '@/lib/assist/assistShortcuts'
import { startAssistUi } from '@/lib/assist/assistUi'
import { revealPane, startAttentionSync } from '@/lib/attention/workspaceActivity'
import { startFileDropTracking } from '@/lib/files/fileDrop'
import { loadHomeDir } from '@/lib/files/homeDir'
import { startModifierRemap } from '@/lib/keyboard/modifierRemapSync'
import { loadEditorLanguages } from '@/lib/monaco/contributedLanguages'
import { setSettingsFile } from '@/lib/monaco/language'
import { startUserActions } from '@/lib/palette/userActions'
import { livePaneIds } from '@/lib/panes/livePanes'
import { startPaneDragTracking } from '@/lib/panes/paneDrag'
import { focusActivePaneWhenReady } from '@/lib/panes/paneFocus'
import { applyStoredPanelWidths } from '@/lib/panes/panelWidth'
import { startKeptReattach } from '@/lib/terminal/keptReattach'
import { loadLocalHostName } from '@/lib/terminal/osc7'
import { applyUiFonts, preloadFonts } from '@/lib/theme/uiFonts'
import { registerViewCommands, startViews } from '@/lib/views/views'
import { restoreSidePanels } from '@/lib/workspaces/restoreSidePanels'
import { initWindow, startWindowSync } from '@/lib/workspaces/windowHandoff'
import { startWorkspaceProjects } from '@/lib/workspaces/workspaceProjects'
import { startAgentGroupsSync } from '@/stores/agents/agentGroupsStore'
import { startApprovals } from '@/stores/agents/approvalsStore'
import { startMail } from '@/stores/agents/mailStore'
import { startQuestions } from '@/stores/agents/questionsStore'
import { startSessionStays } from '@/stores/agents/sessionStaysStore'
import { startKeymapSync } from '@/stores/app/keymapStore'
import { startPlaybookPush } from '@/stores/app/playbookPush'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useSystemThemeStore } from '@/stores/app/systemThemeStore'
import { startUpdateWatch } from '@/stores/app/updateStore'
import { startAssistAvailability } from '@/stores/assist/assistStore'
import { startChatTools } from '@/stores/assist/chatToolsStore'
import { usePluginsStore } from '@/stores/extensions/pluginsStore'
import { wireArtifacts } from '@/stores/files/artifactsStore'
import { useFileTreeStore } from '@/stores/files/fileTreeStore'
import { wireOpenWaits } from '@/stores/files/openWaitsStore'
import { wireRemoteFolders } from '@/stores/files/remoteFoldersStore'
import { startSyncAttention } from '@/stores/server/syncAttentionStore'
import { startPaneRecencySync } from '@/stores/workspaces/paneRecencyStore'
import { startPaneRenameSync } from '@/stores/workspaces/paneRenameStore'
import { startSnapshotAutosave } from '@/stores/workspaces/persistence'
import { startRailEditSync } from '@/stores/workspaces/railEditStore'
import { useWindowsStore } from '@/stores/workspaces/windowsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { App } from './App'
import { registerAgentCommand } from './commands/agentCommand'
import { startAskCommand } from './commands/askCommand'
import { startAssistCompose } from './commands/assistCompose'
import { startAssistToggleCommands } from './commands/assistToggles'
import { wireCommandBridge } from './commands/bridge'
import { registerBuiltinCommands } from './commands/builtins'
import { startChatCommand } from './commands/chatCommand'
import { wireExtensionBridge } from './commands/extensionBridge'
import { registerExternalEditorCommand } from './commands/externalEditor'
import { wireManagerBridge } from './commands/managerBridge'
import { wirePaneRunBridge } from './commands/paneRunBridge'
import { registerRegionCaptureCommand } from './commands/regionCapture'
import { registerSelectionSendCommand } from './commands/selectionSend'
import { wireTerminalStateBridge } from './commands/terminalStateBridge'
import { registerWindowCommands } from './commands/windowCommands'
import { isMac } from './platform'

startErrorReporting()
startFocusModality()
startModifierRemap(isMac)
startCtrlTracking()
watchScrolling(document)
registerBuiltinCommands()
registerExternalEditorCommand()
registerSelectionSendCommand()
registerRegionCaptureCommand()
registerViewCommands()
wireCommandBridge()
wireTerminalStateBridge()
wireExtensionBridge()
wireArtifacts()
wireOpenWaits()
wirePaneRunBridge()
wireManagerBridge()
wireRemoteFolders()
if (isMac) startAppMenu()

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')
const root = createRoot(container)

async function boot(): Promise<void> {
  await initWindow()
  registerWindowCommands(useWindowsStore.getState().detached)
  await Promise.all([loadLocalHostName(), loadHomeDir(), loadDesktops()])
  try {
    await useSettingsStore.getState().init()
  } catch (err) {
    console.error('[settings] load failed', err)
  }
  try {
    setSettingsFile(await window.ostia.settings.path())
  } catch (err) {
    console.error('[settings] path unavailable', err)
  }
  try {
    await loadEditorLanguages()
  } catch (err) {
    console.error('[editor languages] load failed', err)
  }
  try {
    await usePluginsStore.getState().loadLanguages()
  } catch (err) {
    console.error('[languages] load failed', err)
  }
  startKeymapSync()
  startPlaybookPush()
  const { ui, editor, terminal } = useSettingsStore.getState().appearance
  applyUiFonts(document.documentElement, { ui, editor })
  await preloadFonts({ ui, editor, terminal })
  try {
    await useSystemThemeStore.getState().init()
  } catch (err) {
    console.error('[theme] system appearance unavailable', err)
  }
  let snapshot = null
  try {
    snapshot = await window.ostia.workspace.load()
  } catch (err) {
    console.error('[workspace] restore failed', err)
  }
  useWorkspacesStore.getState().hydrate(snapshot)
  restoreSidePanels(snapshot)
  const restoredWorkspaceId = useWorkspacesStore.getState().activeWorkspaceId
  if (restoredWorkspaceId) focusActivePaneWhenReady(restoredWorkspaceId)
  startSnapshotAutosave()
  startWindowSync()
  startPaneDragTracking()
  startFileDropTracking()
  startAttentionSync()
  startPaneRecencySync()
  startPaneRenameSync()
  startRailEditSync()
  startHibernation()
  startKeptReattach()
  startAutoResume()
  startActivationResume()
  startAgentDetection()
  startAgentRunningReport()
  startWorkspaceProjects()
  startApprovals()
  startAgentGroupsSync()
  startQuestions()
  startSyncAttention()
  startMail()
  startSessionStays()
  startUserActions()
  startViews()
  startUpdateWatch()
  startAssistAvailability()
  startChatTools()
  startAskCommand()
  startChatCommand()
  registerAgentCommand()
  startAssistUi()
  startAssistCompose()
  startAssistToggleCommands()
  startShortcutReporting()
  applyStoredPanelWidths()
  window.ostia.notifications.onActivate((paneId) => revealPane(paneId))
  window.ostia.settings.onChanged(() => void useSettingsStore.getState().init())
  window.ostia.files.onKindsChanged(() => useFileTreeStore.getState().reloadAll())
  root.render(
    <StrictMode>
      <AppErrorBoundary>
        <App />
        <CrashTestHook />
      </AppErrorBoundary>
    </StrictMode>,
  )
  window.ostia.diagnostics.ready(livePaneIds())
}

boot().catch((err: unknown) => {
  reportError('render', err, 'boot')
  root.render(<RecoveryScreen error={errorDetails(err)} />)
})
