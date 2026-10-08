import { type FontWeight, type ITerminalOptions, Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { type RefObject, useEffect } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { currentScheme, terminalTheme, useScheme } from './colorScheme'
import { terminalFontStack } from './uiFonts'

export type ReadOnlyTerminal = Xterm

export function createReadOnlyTerminal(options: ITerminalOptions = {}): ReadOnlyTerminal {
  const font = useSettingsStore.getState().appearance.terminal
  return new Xterm({
    theme: terminalTheme(currentScheme('terminal').colors),
    fontFamily: terminalFontStack(font.family),
    fontSize: font.size,
    fontWeight: font.weight as FontWeight,
    lineHeight: font.lineHeight,
    scrollback: useSettingsStore.getState().terminal.scrollbackLines,
    disableStdin: true,
    allowProposedApi: true,
    ...options,
  })
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

export function useReadOnlyTerminalFont(termRef: RefObject<ReadOnlyTerminal | null>): void {
  const font = useSettingsStore((s) => s.appearance.terminal)
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = terminalFontStack(font.family)
    term.options.fontSize = font.size
    term.options.fontWeight = font.weight as FontWeight
    term.options.lineHeight = font.lineHeight
  }, [font.family, font.size, font.weight, font.lineHeight, termRef])
}
