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
import { wireTerminalStateBridge } from './commands/terminalStateBridge'
import { revealPane, startAttentionSync } from './lib/sessionActivity'
import { startPaneRecencySync } from './stores/paneRecencyStore'
import { startWorkspaceAutosave } from './stores/persistence'
import { useSessionsStore } from './stores/sessionsStore'
import { useSettingsStore } from './stores/settingsStore'

registerBuiltinCommands()
wireCommandBridge()
wireTerminalStateBridge()
wireExtensionBridge()

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')
const root = createRoot(container)

async function boot(): Promise<void> {
  let snapshot = null
  try {
    snapshot = (await window.pine?.session?.load?.()) ?? null
  } catch (err) {
    console.error('[session] restore failed', err)
  }
  useSessionsStore.getState().hydrate(snapshot)
  startWorkspaceAutosave()
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
