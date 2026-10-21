import { useEffect, useRef, useState } from 'react'
import { isPaneVisible } from '@/lib/attention/workspaceActivity'
import { keyboardPaneId } from '@/lib/layout/focusDirection'
import { guestReached } from '@/lib/panes/guestReached'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import {
  focusSurfaceWhenReady,
  retryPendingFocus,
  setFocusTarget,
} from '@/stores/workspaces/surfaceSlotsStore'

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

export function useGuestReady(webview: HTMLElement | null): HTMLElement | null {
  const [ready, setReady] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!webview) return
    const onReady = (): void => setReady(webview)
    webview.addEventListener('dom-ready', onReady)
    if (guestReached(webview)) onReady()
    return () => webview.removeEventListener('dom-ready', onReady)
  }, [webview])
  const shown = ready !== null && ready === webview ? ready : null
  useEffect(() => {
    if (shown) retryPendingFocus()
  }, [shown])
  return shown
}
