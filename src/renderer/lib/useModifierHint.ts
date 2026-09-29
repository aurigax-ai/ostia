import { useEffect } from 'react'
import { useUIStore } from '../stores/uiStore'

export const MODIFIER_HINT_DELAY_MS = 500

export function useModifierHint(mac: boolean): void {
  useEffect(() => {
    const modifier = mac ? 'Meta' : 'Control'
    let timer: ReturnType<typeof setTimeout> | null = null
    const hide = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      if (useUIStore.getState().digitHints) useUIStore.getState().setDigitHints(false)
    }
    const onDown = (e: KeyboardEvent): void => {
      if (e.key !== modifier || e.repeat) {
        if (e.key !== modifier) hide()
        return
      }
      hide()
      timer = setTimeout(() => useUIStore.getState().setDigitHints(true), MODIFIER_HINT_DELAY_MS)
    }
    const onUp = (e: KeyboardEvent): void => {
      if (e.key === modifier) hide()
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', hide)
    return () => {
      hide()
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', hide)
    }
  }, [mac])
}
