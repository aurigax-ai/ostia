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
import { wireTerminalStateBridge } from './commands/terminalStateBridge'
import { startWorkspaceAutosave } from './stores/persistence'
import { useSessionsStore } from './stores/sessionsStore'

registerBuiltinCommands()
wireCommandBridge()
wireTerminalStateBridge()

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
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
