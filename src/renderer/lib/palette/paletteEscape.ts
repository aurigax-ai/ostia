const IME_KEY_CODE = 229

interface EscapeKey {
  key: string
  code: string
  keyCode: number
  isComposing: boolean
}

export function isComposingEscape(e: EscapeKey): boolean {
  if (e.key !== 'Escape' && e.code !== 'Escape') return false
  return e.isComposing || e.keyCode === IME_KEY_CODE
}

export function swallowHeldEscape(target: Window = window): void {
  const release = (): void => {
    target.removeEventListener('keydown', onKeyDown, true)
    target.removeEventListener('keyup', release, true)
    target.removeEventListener('blur', release)
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!e.repeat || e.code !== 'Escape') {
      release()
      return
    }
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  target.addEventListener('keydown', onKeyDown, true)
  target.addEventListener('keyup', release, true)
  target.addEventListener('blur', release)
}
