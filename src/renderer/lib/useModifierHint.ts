import { useEffect } from 'react'
import { useUIStore } from '../stores/uiStore'
import type { ChordSpec } from './chordSpec'
import { WORKSPACE_GOTO, chordOf } from './chords'

export const MODIFIER_HINT_DELAY_MS = 500

const MODIFIER_FLAGS: Record<string, keyof Omit<ChordSpec, 'key'>> = {
  Control: 'ctrl',
  Shift: 'shift',
  Alt: 'alt',
  Meta: 'meta',
}

const FLAGS = ['ctrl', 'shift', 'alt', 'meta'] as const

function heldModifiers(e: KeyboardEvent, pressed: string): Set<string> {
  const held = new Set<string>([pressed])
  if (e.ctrlKey) held.add('ctrl')
  if (e.shiftKey) held.add('shift')
  if (e.altKey) held.add('alt')
  if (e.metaKey) held.add('meta')
  return held
}

function holdsExactly(held: ReadonlySet<string>, spec: ChordSpec): boolean {
  const wanted = FLAGS.filter((flag) => spec[flag])
  return wanted.length === held.size && wanted.every((flag) => held.has(flag))
}

export function useModifierHint(mac: boolean): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const hide = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      if (useUIStore.getState().digitHints) useUIStore.getState().setDigitHints(false)
    }
    const onDown = (e: KeyboardEvent): void => {
      const flag = MODIFIER_FLAGS[e.key]
      if (!flag) {
        hide()
        return
      }
      if (e.repeat) return
      hide()
      const goto = chordOf(WORKSPACE_GOTO, mac)
      if (!goto || !holdsExactly(heldModifiers(e, flag), goto)) return
      timer = setTimeout(() => useUIStore.getState().setDigitHints(true), MODIFIER_HINT_DELAY_MS)
    }
    const onUp = (e: KeyboardEvent): void => {
      if (MODIFIER_FLAGS[e.key]) hide()
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
