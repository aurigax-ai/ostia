import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

type SelectionCopier = () => Promise<void> | null

const copiers = new Map<string, SelectionCopier>()

export function registerSelectionCopier(paneId: string, copier: SelectionCopier): () => void {
  copiers.set(paneId, copier)
  return () => {
    if (copiers.get(paneId) === copier) copiers.delete(paneId)
  }
}

export function copyPaneSelection(paneId: string): boolean {
  const copying = copiers.get(paneId)?.()
  if (!copying) return false
  void copying
  return true
}

function activePaneId(): string | null {
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  return workspaceId
    ? (useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId ?? null)
    : null
}

export function hasActivePaneCopier(): boolean {
  const paneId = activePaneId()
  return paneId !== null && copiers.has(paneId)
}

export function copyActivePaneSelection(): boolean {
  const paneId = activePaneId()
  return paneId ? copyPaneSelection(paneId) : false
}
