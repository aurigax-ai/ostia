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
import { DetachedPane } from './components/DetachedPane'
import { useSessionsStore } from './stores/sessionsStore'

// Register the Phase 0 command set before the UI mounts, then wire main's command
// bridge (Slice 6) so it can list + execute this window's registry.
registerBuiltinCommands()
wireCommandBridge()
// Slice 7: mirror per-pane terminal state (cwd/running/blocks/exit code) to main. A
// passive observer — wiring it in changes no terminal/UI behavior.
wireTerminalStateBridge()

// Seed main's session→workDir registry with the store's initial session(s): that
// session was created before `window.pine` existed, so its `session-added` never
// fired. Without this, main-side services can't resolve a workDir for it.
for (const s of useSessionsStore.getState().sessions) {
  window.pine?.lifecycle?.emit?.({ type: 'session-added', sessionId: s.id, workDir: s.workDir })
}

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

// A window opened with `?detached=1` hosts a single torn-off pane, not the full shell.
const isDetached = new URLSearchParams(window.location.search).has('detached')

createRoot(container).render(<StrictMode>{isDetached ? <DetachedPane /> : <App />}</StrictMode>)
