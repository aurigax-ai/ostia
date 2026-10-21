import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { registerBrowserCommands } from './browserCommands'
import { registerAppViewCommands } from './core/appViewCommands'
import { registerFileOpenCommands } from './core/fileOpenCommands'
import { registerListCommands } from './core/listCommands'
import { registerPaneAgentCommands } from './core/paneAgentCommands'
import { registerPaneLayoutCommands } from './core/paneLayoutCommands'
import { registerParkCommands } from './core/parkCommands'
import { registerSettingsCommands } from './core/settingsCommands'
import { registerTerminalCommands } from './core/terminalCommands'
import { registerWorkspaceGroupCommands } from './core/workspaceGroupCommands'
import { registerWorkspaceLifecycleCommands } from './core/workspaceLifecycleCommands'
import { registerGitCommands } from './gitCommands'
import { registerPaneTabCommands } from './paneTabCommands'
import { type CommandContext, commands } from './registry'

export function registerBuiltinCommands(): void {
  registerBrowserCommands()
  registerGitCommands()
  registerPaneTabCommands()
  commands.setContextProvider((): CommandContext => {
    const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
    const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
    return { activeWorkspaceId: workspaceId, activePaneId: layout?.activePaneId ?? null }
  })
  registerPaneLayoutCommands()
  registerPaneAgentCommands()
  registerParkCommands()
  registerTerminalCommands()
  registerWorkspaceGroupCommands()
  registerWorkspaceLifecycleCommands()
  registerAppViewCommands()
  registerFileOpenCommands()
  registerListCommands()
  registerSettingsCommands()
}
