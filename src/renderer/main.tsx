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
import { DetachedPane } from './components/DetachedPane'

// Register the Phase 0 command set before the UI mounts, then wire main's command
// bridge (Slice 6) so it can list + execute this window's registry.
registerBuiltinCommands()
wireCommandBridge()

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

// A window opened with `?detached=1` hosts a single torn-off pane, not the full shell.
const isDetached = new URLSearchParams(window.location.search).has('detached')

createRoot(container).render(<StrictMode>{isDetached ? <DetachedPane /> : <App />}</StrictMode>)
