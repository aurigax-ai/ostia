import { type RefObject, useEffect } from 'react'
import { matchChordInTerminal } from '@/lib/keyboard/chords'
import { smartClipboardAction } from '@/lib/keyboard/clipboardKeys'
import { terminalTheme, useScheme } from '@/lib/theme/colorScheme'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { ghosttyModule } from './ghosttyEngine'
import type { OstiaTerminal, TerminalOptions } from './ostiaTerminal'

export type ReadOnlyTerminal = OstiaTerminal

const NO_LINKS = { activate: () => {}, hover: () => {}, leave: () => {} }

export function readOnlyCopyKey(e: KeyboardEvent, hasSelection: boolean): boolean {
  const clipboardKeys = useSettingsStore.getState().terminal.clipboardKeys
  if (smartClipboardAction(e, clipboardKeys, hasSelection, isMac) === 'copy') return true
  return matchChordInTerminal(e, isMac) === 'copy'
}

export function createReadOnlyTerminal(options: TerminalOptions): ReadOnlyTerminal {
  const ghostty = ghosttyModule()
  if (!ghostty) throw new Error('Ghostty engine is not loaded')
  const term = ghostty.createGhosttyTerminal(options, false, NO_LINKS).term
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && readOnlyCopyKey(e, term.hasSelection())) {
      e.preventDefault()
      void navigator.clipboard.writeText(term.getSelection())
    }
    return false
  })
  return term
}

export function useReadOnlyTerminalBackground(
  termRef: RefObject<ReadOnlyTerminal | null>,
): string | undefined {
  const palette = useScheme('terminal').colors
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(palette)
  }, [palette, termRef])
  return palette.background
}
