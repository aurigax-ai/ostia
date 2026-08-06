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
import { startWorkspaceAutosave } from './stores/persistence'
import { useSessionsStore } from './stores/sessionsStore'

// Register the Phase 0 command set before the UI mounts, then wire main's command
// bridge (Slice 6) so it can list + execute this window's registry.
registerBuiltinCommands()
wireCommandBridge()
// Slice 7: mirror per-pane terminal state (cwd/running/blocks/exit code) to main. A
// passive observer — wiring it in changes no terminal/UI behavior.
wireTerminalStateBridge()

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')
const root = createRoot(container)

// A window opened with `?detached=1` hosts a single torn-off pane, not the full shell —
// it owns no workspace, so it neither restores nor autosaves one.
const isDetached = new URLSearchParams(window.location.search).has('detached')

/**
 * Restore the previous run's workspace, then mount (session restore — see
 * `stores/persistence.ts`). Hydration MUST land before the first render: `WorkZone` calls
 * `layoutStore.ensure` as it mounts, and a pane mounted against the seeded layout would
 * spawn a pty we'd orphan a tick later. `hydrate` also does the session→workDir seeding
 * main needs (those sessions exist before `window.pine` does, so their `session-added`
 * never fired on their own).
 */
async function boot(): Promise<void> {
  let snapshot = null
  try {
    snapshot = (await window.pine?.session?.load?.()) ?? null
  } catch (err) {
    // A workspace we can't read is not a reason to fail to start — boot fresh instead.
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

if (isDetached) {
  root.render(
    <StrictMode>
      <DetachedPane />
    </StrictMode>,
  )
} else {
  void boot()
}
