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
import { wireCommandBridge } from './commands/bridge'
import { registerBuiltinCommands } from './commands/builtins'
import { wireExtensionBridge } from './commands/extensionBridge'
import { registerExternalEditorCommand } from './commands/externalEditor'
import { registerSelectionSendCommand } from './commands/selectionSend'
import { wireTerminalStateBridge } from './commands/terminalStateBridge'
import { startAutoResume } from './lib/autoResume'
import { startHibernation } from './lib/hibernationScheduler'
import { startAgentDetection } from './lib/paneAgent'
import { startUserActions } from './lib/userActions'
import { registerViewCommands, startViews } from './lib/views'
import { revealPane, startAttentionSync } from './lib/workspaceActivity'
import { startWorkspaceProjects } from './lib/workspaceProjects'
import { startApprovals } from './stores/approvalsStore'
import { startPaneRecencySync } from './stores/paneRecencyStore'
import { startSnapshotAutosave } from './stores/persistence'
import { useSettingsStore } from './stores/settingsStore'
import { useSystemThemeStore } from './stores/systemThemeStore'
import { startUpdateWatch } from './stores/updateStore'
import { useWorkspacesStore } from './stores/workspacesStore'

registerBuiltinCommands()
registerExternalEditorCommand()
registerSelectionSendCommand()
registerViewCommands()
wireCommandBridge()
wireTerminalStateBridge()
wireExtensionBridge()

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')
const root = createRoot(container)

async function boot(): Promise<void> {
  try {
    await useSettingsStore.getState().init()
  } catch (err) {
    console.error('[settings] load failed', err)
  }
  try {
    await useSystemThemeStore.getState().init()
  } catch (err) {
    console.error('[theme] system appearance unavailable', err)
  }
  let snapshot = null
  try {
    snapshot = (await window.pine?.workspace?.load?.()) ?? null
  } catch (err) {
    console.error('[workspace] restore failed', err)
  }
  useWorkspacesStore.getState().hydrate(snapshot)
  startSnapshotAutosave()
  startAttentionSync()
  startPaneRecencySync()
  startHibernation()
  startAutoResume()
  startAgentDetection()
  startWorkspaceProjects()
  startApprovals()
  startUserActions()
  startViews()
  startUpdateWatch()
  window.pine?.notifications?.onActivate?.((paneId) => revealPane(paneId))
  window.pine?.settings?.onChanged?.(() => void useSettingsStore.getState().init())
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
