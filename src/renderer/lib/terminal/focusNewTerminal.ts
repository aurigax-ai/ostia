import { useLayoutStore } from '@/stores/layoutStore'
import { focusSurfaceWhenReady } from '@/stores/surfaceSlotsStore'

export function focusActivePaneWhenReady(workspaceId: string): void {
  const paneId = useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId
  if (paneId) focusSurfaceWhenReady(paneId)
}
