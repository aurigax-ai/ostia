import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { copyCapture, useCaptureStore } from './captureSession'

function activePaneId(): string | null {
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  return workspaceId
    ? (useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId ?? null)
    : null
}

export function hasActiveCapture(): boolean {
  const paneId = activePaneId()
  return paneId !== null && useCaptureStore.getState().open[paneId] !== undefined
}

export function copyActiveCapture(): boolean {
  const paneId = activePaneId()
  if (!paneId) return false
  const copying = copyCapture(paneId)
  if (!copying) return false
  void copying
  return true
}
