let focusBeforePalette: HTMLElement | null = null

export function releaseFocusForPalette(): void {
  focusBeforePalette = null
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
  if (!target?.isConnected) return true
  return focusMovedAway(target) ? false : target
}
