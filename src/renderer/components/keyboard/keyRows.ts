import type { ChordValue } from '@shared/keyboard/chordSpec'
import { useRef } from 'react'

export function keepChords(texts: string[]): ChordValue | null {
  if (texts.length === 0) return null
  return texts.length === 1 ? texts[0] : texts
}

export function useCollapse(expanded: boolean, onToggle: () => void, before: () => void) {
  const toggleRef = useRef<HTMLButtonElement>(null)
  const toggle = (): void => {
    before()
    onToggle()
  }
  const collapse = (): void => {
    if (!expanded) return
    before()
    onToggle()
    toggleRef.current?.focus()
  }
  return { toggleRef, toggle, collapse }
}
