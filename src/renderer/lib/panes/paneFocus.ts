import { isPaneVisible } from '@/lib/attention/workspaceActivity'
import { keyboardPaneId } from '@/lib/layout/focusDirection'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { focusSurfaceWhenReady, setFocusTarget } from '@/stores/workspaces/surfaceSlotsStore'
import { useEffect, useRef } from 'react'

export function focusPaneWhenReady(paneId: string): void {
  focusSurfaceWhenReady(paneId, () => isPaneVisible(paneId))
}

export function focusActivePaneWhenReady(workspaceId: string): void {
  const layout = useLayoutStore.getState().byWorkspace[workspaceId]
  if (layout) focusPaneWhenReady(keyboardPaneId(layout))
}

export function useSurfaceFocus(
  paneId: string | undefined,
  target: (() => HTMLElement | null) | null,
): void {
  const targetRef = useRef(target)
  targetRef.current = target
  const takesKeyboard = target !== null
  useEffect(() => {
    if (!paneId) return
    return setFocusTarget(paneId, takesKeyboard ? () => targetRef.current?.() ?? null : null)
  }, [paneId, takesKeyboard])
}
