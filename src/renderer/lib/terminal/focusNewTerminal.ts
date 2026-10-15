import { isPaneVisible } from '@/lib/attention/workspaceActivity'
import { keyboardPaneId } from '@/lib/layout/focusDirection'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { focusSurfaceWhenReady } from '@/stores/workspaces/surfaceSlotsStore'

export function focusPaneWhenReady(paneId: string): void {
  focusSurfaceWhenReady(paneId, () => isPaneVisible(paneId))
}

export function focusActivePaneWhenReady(workspaceId: string): void {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  if (layout) focusPaneWhenReady(keyboardPaneId(layout))
}
