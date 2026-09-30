import { useEditorRevealStore } from '../stores/editorRevealStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'

export function openFileInWorkspace(path: string): void {
  if (!useWorkspacesStore.getState().activeWorkspaceId) useWorkspacesStore.getState().addWorkspace()
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  if (workspaceId) useLayoutStore.getState().openFile(workspaceId, path)
}

export function openFileAt(path: string, line?: number, column?: number): void {
  if (line) useEditorRevealStore.getState().request(path, { line, column: column ?? 1 })
  openFileInWorkspace(path)
}
