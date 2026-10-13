import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { focusSurfaceWhenReady } from '@/stores/workspaces/surfaceSlotsStore'

export function focusActivePaneWhenReady(workspaceId: string): void {
  const paneId = useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId
  if (paneId) focusSurfaceWhenReady(paneId)
}
