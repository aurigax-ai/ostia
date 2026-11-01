import { keyboardPaneId } from '@/lib/layout/focusDirection'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

let focusBeforePalette: HTMLElement | null = null
let paneBeforePalette: string | null = null

function keyboardPane(): string | null {
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  return layout ? keyboardPaneId(layout) : null
}

export function releaseFocusForPalette(): void {
  focusBeforePalette = null
  paneBeforePalette = keyboardPane()
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active === document.body) return
  if (active.closest('[role="dialog"]')) return
  focusBeforePalette = active
  holdFocusInWindow()
}

function holdFocusInWindow(): void {
  const body = document.body
  body.tabIndex = -1
  body.focus({ preventScroll: true })
  body.removeAttribute('tabindex')
}

function focusMovedAway(target: HTMLElement): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active === document.body || active === target) {
    return false
  }
  return !active.closest('[role="dialog"]')
}

export function paletteReturnFocus(): HTMLElement | boolean {
  const target = focusBeforePalette
  focusBeforePalette = null
  if (paneBeforePalette !== keyboardPane()) return false
  if (document.querySelector('[role="dialog"][data-open]')) return false
  if (!target?.isConnected) return true
  if (target.closest('[inert], [data-hidden]')) return false
  return focusMovedAway(target) ? false : target
}
