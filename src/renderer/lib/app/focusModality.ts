const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

export function isNavigationKey(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>,
): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey && NAVIGATION_KEYS.has(e.key)
}

export function startFocusModality(target: Window = window): () => void {
  const root = target.document.documentElement
  const onKeyDown = (e: KeyboardEvent): void => {
    if (isNavigationKey(e)) root.dataset.keyboardNav = ''
  }
  const onPointerDown = (): void => {
    delete root.dataset.keyboardNav
  }
  root.dataset.keyboardNav = ''
  target.addEventListener('keydown', onKeyDown, true)
  target.addEventListener('pointerdown', onPointerDown, true)
  return () => {
    target.removeEventListener('keydown', onKeyDown, true)
    target.removeEventListener('pointerdown', onPointerDown, true)
    delete root.dataset.keyboardNav
  }
}
