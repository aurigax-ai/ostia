import { focusActivePaneWhenReady } from '@/lib/panes/paneFocus'
import { useSidePanelStore } from '@/stores/app/sidePanelStore'
import { focusSurfaceWhenReady } from '@/stores/workspaces/surfaceSlotsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

export const RIGHT_PANEL_ID = 'right-panel'

export function rightFocusKey(extId: string, workspaceId: string): string {
  return `side:${extId}:${workspaceId}`
}

export function focusRightPanel(): void {
  const extId = useSidePanelStore.getState().right
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  if (!extId || !workspaceId) return
  focusSurfaceWhenReady(
    rightFocusKey(extId, workspaceId),
    () =>
      useSidePanelStore.getState().right === extId &&
      useWorkspacesStore.getState().activeWorkspaceId === workspaceId,
  )
}

export function hideRightPanel(): void {
  const focusedInside = document.activeElement?.closest(`#${RIGHT_PANEL_ID}`) != null
  useSidePanelStore.getState().hideRight()
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  if (focusedInside && workspaceId) focusActivePaneWhenReady(workspaceId)
}

export function toggleRightPanel(extId: string): void {
  if (useSidePanelStore.getState().right === extId) {
    hideRightPanel()
    return
  }
  useSidePanelStore.getState().showRight(extId)
  focusRightPanel()
}
