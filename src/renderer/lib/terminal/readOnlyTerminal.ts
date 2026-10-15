import { type FontWeight, type ITerminalOptions, Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { matchChordInTerminal } from '@/lib/keyboard/chords'
import { smartClipboardAction } from '@/lib/keyboard/clipboardKeys'
import { currentScheme, terminalTheme, useScheme } from '@/lib/theme/colorScheme'
import { terminalFontStack } from '@/lib/theme/uiFonts'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { type RefObject, useEffect } from 'react'

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

function readOnlyCopyKey(e: KeyboardEvent, hasSelection: boolean): boolean {
  const clipboardKeys = useSettingsStore.getState().terminal.clipboardKeys
  if (smartClipboardAction(e, clipboardKeys, hasSelection, isMac) === 'copy') return true
  return matchChordInTerminal(e, isMac) === 'copy'
}

export interface MountedReadOnlyTerminal {
  term: ReadOnlyTerminal
  dispose: () => void
}

export function mountReadOnlyTerminal(
  host: HTMLElement,
  options: ITerminalOptions = {},
  onKey?: (e: KeyboardEvent) => void,
): MountedReadOnlyTerminal {
  const settings = useSettingsStore.getState().terminal
  const term = createReadOnlyTerminal({
    scrollSensitivity: settings.scrollSpeed,
    minimumContrastRatio: settings.minimumContrast,
    cursorInactiveStyle: 'none',
    ...options,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return false
    if (readOnlyCopyKey(e, term.hasSelection())) {
      e.preventDefault()
      void navigator.clipboard.writeText(term.getSelection())
      return false
    }
    onKey?.(e)
    return false
  })
  term.open(host)
  const refit = (): void => {
    if (host.offsetWidth === 0 || host.offsetHeight === 0) return
    fit.fit()
  }
  refit()
  const observer = new ResizeObserver(refit)
  observer.observe(host)
  return {
    term,
    dispose: () => {
      observer.disconnect()
      term.dispose()
    },
  }
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
