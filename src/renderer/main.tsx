import '@fontsource-variable/inter/index.css'
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import './assets/fonts/hack-nerd-font.css'
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
import { revealPane, startAttentionSync } from './lib/workspaceActivity'
import { startPaneRecencySync } from './stores/paneRecencyStore'
import { startSnapshotAutosave } from './stores/persistence'
import { useSettingsStore } from './stores/settingsStore'
import { useWorkspacesStore } from './stores/workspacesStore'

registerBuiltinCommands()
registerExternalEditorCommand()
registerSelectionSendCommand()
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
  window.pine?.notifications?.onActivate?.((paneId) => revealPane(paneId))
  window.pine?.settings?.onChanged?.(() => void useSettingsStore.getState().init())
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
