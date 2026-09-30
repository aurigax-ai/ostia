import { findPane } from '../layout/tree'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'

export function newWorkspaceDir(
  inheritFolder: boolean,
  defaultFolder: string,
  focusedCwd: string | undefined,
): string {
  return inheritFolder && focusedCwd ? focusedCwd : defaultFolder
}

function focusedPaneCwd(): string | undefined {
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  if (!layout?.activePaneId) return undefined
  return findPane(layout.root, layout.activePaneId)?.cwd
}

export function startNewWorkspace(): void {
  const { placement, inheritFolder, defaultFolder } = useSettingsStore.getState().workspaces
  useWorkspacesStore
    .getState()
    .addWorkspace(newWorkspaceDir(inheritFolder, defaultFolder, focusedPaneCwd()), placement)
}
