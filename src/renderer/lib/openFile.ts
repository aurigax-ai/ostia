import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'

export function openFileInWorkspace(path: string): void {
  if (!useWorkspacesStore.getState().activeWorkspaceId) useWorkspacesStore.getState().addWorkspace()
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  if (workspaceId) useLayoutStore.getState().openFile(workspaceId, path)
}
