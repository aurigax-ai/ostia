import { app } from 'electron'
import { createAgentServices } from './boot/agentServices'
import { createAppState } from './boot/appState'
import { boot } from './boot/bootPhases'
import { createBrowserServices } from './boot/browserServices'
import { createConfinedServices } from './boot/confinedServices'
import { createFeatureServices } from './boot/featureServices'
import { createPaneServices } from './boot/paneServices'
import { createQuitServices } from './boot/quitServices'
import { createSharedServices } from './boot/sharedServices'
import { createWindowShell } from './boot/windowShell'
import { createWorkspaceServices } from './boot/workspaceServices'

const appState = createAppState()
const shared = { ...appState, ...createSharedServices(appState) }
const confined = { ...shared, ...createConfinedServices(shared) }
const browser = { ...confined, ...createBrowserServices(confined) }
const workspace = { ...browser, ...createWorkspaceServices(browser) }
const agent = { ...workspace, ...createAgentServices(workspace) }
const pane = { ...agent, ...createPaneServices(agent) }
const windowShell = { ...pane, ...createWindowShell(pane) }
const feature = { ...windowShell, ...createFeatureServices(windowShell) }
const wiring = { ...feature, ...createQuitServices(feature) }

app.whenReady().then(() => boot(wiring))
