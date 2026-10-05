import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import './assets/fonts/hack-nerd-font.css'
import './assets/fonts/meslo-nerd-font.css'
import 'allotment/dist/style.css'
import './index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
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
import { AppErrorBoundary, CrashTestHook, RecoveryScreen } from './components/AppErrorBoundary'
import { startAgentRunningReport } from './lib/agentRunningReport'
import { startAppMenu } from './lib/appMenu'
import { startShortcutReporting } from './lib/assistShortcuts'
import { startAssistUi } from './lib/assistUi'
import { startAutoResume } from './lib/autoResume'
import { errorDetails, reportError, startErrorReporting } from './lib/errorReporting'
import { startFileDropTracking } from './lib/fileDrop'
import { startHibernation } from './lib/hibernationScheduler'
import { livePaneIds } from './lib/livePanes'
import { loadLocalHostName } from './lib/osc7'
import { startAgentDetection } from './lib/paneAgent'
import { startPaneDragTracking } from './lib/paneDrag'
import { applyStoredPanelWidths } from './lib/panelWidth'
import { applyUiFonts, preloadFonts } from './lib/uiFonts'
import { startUserActions } from './lib/userActions'
import { registerViewCommands, startViews } from './lib/views'
import { initWindow, startWindowSync } from './lib/windowHandoff'
import { revealPane, startAttentionSync } from './lib/workspaceActivity'
import { startWorkspaceProjects } from './lib/workspaceProjects'
import { loadEditorLanguages } from './monaco/contributedLanguages'
import { setSettingsFile } from './monaco/language'
import { isMac } from './platform'
import { startApprovals } from './stores/approvalsStore'
import { startAssistAvailability } from './stores/assistStore'
import { startChatTools } from './stores/chatToolsStore'
import { startKeymapSync } from './stores/keymapStore'
import { startPaneRecencySync } from './stores/paneRecencyStore'
import { startSnapshotAutosave } from './stores/persistence'
import { usePluginsStore } from './stores/pluginsStore'
import { startQuestions } from './stores/questionsStore'
import { wireRemoteFolders } from './stores/remoteFoldersStore'
import { useSettingsStore } from './stores/settingsStore'
import { useSystemThemeStore } from './stores/systemThemeStore'
import { startUpdateWatch } from './stores/updateStore'
import { useWindowsStore } from './stores/windowsStore'
import { useWorkspacesStore } from './stores/workspacesStore'

startErrorReporting()
registerBuiltinCommands()
registerExternalEditorCommand()
registerSelectionSendCommand()
registerRegionCaptureCommand()
registerViewCommands()
wireCommandBridge()
wireTerminalStateBridge()
wireExtensionBridge()
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
  await loadLocalHostName()
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
    snapshot = (await window.ostia?.workspace?.load?.()) ?? null
  } catch (err) {
    console.error('[workspace] restore failed', err)
  }
  useWorkspacesStore.getState().hydrate(snapshot)
  startSnapshotAutosave()
  startWindowSync()
  startPaneDragTracking()
  startFileDropTracking()
  startAttentionSync()
  startPaneRecencySync()
  startHibernation()
  startAutoResume()
  startAgentDetection()
  startAgentRunningReport()
  startWorkspaceProjects()
  startApprovals()
  startQuestions()
  startUserActions()
  startViews()
  startUpdateWatch()
  startAssistAvailability()
  startChatTools()
  startAskCommand()
  startChatCommand()
  startAssistUi()
  startAssistCompose()
  startAssistToggleCommands()
  startShortcutReporting()
  applyStoredPanelWidths()
  window.ostia?.notifications?.onActivate?.((paneId) => revealPane(paneId))
  window.ostia?.settings?.onChanged?.(() => void useSettingsStore.getState().init())
  root.render(
    <StrictMode>
      <AppErrorBoundary>
        <App />
        <CrashTestHook />
      </AppErrorBoundary>
    </StrictMode>,
  )
  window.ostia?.diagnostics?.ready(livePaneIds())
}

boot().catch((err: unknown) => {
  reportError('render', err, 'boot')
  root.render(<RecoveryScreen error={errorDetails(err)} />)
})
