import { type FontWeight, type ITerminalOptions, Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { type RefObject, useEffect } from 'react'
import { matchChordInTerminal } from '@/lib/keyboard/chords'
import { smartClipboardAction } from '@/lib/keyboard/clipboardKeys'
import { currentScheme, terminalTheme, useScheme } from '@/lib/theme/colorScheme'
import { terminalFontStack } from '@/lib/theme/uiFonts'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'

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

export function readOnlyCopyKey(e: KeyboardEvent, hasSelection: boolean): boolean {
  const clipboardKeys = useSettingsStore.getState().terminal.clipboardKeys
  if (smartClipboardAction(e, clipboardKeys, hasSelection, isMac) === 'copy') return true
  return matchChordInTerminal(e, isMac) === 'copy'
}

export interface MountedReadOnlyTerminal {
  term: ReadOnlyTerminal
  dispose: () => void
}

function wireReadOnly(term: ReadOnlyTerminal): void {
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return false
    if (readOnlyCopyKey(e, term.hasSelection())) {
      e.preventDefault()
      void navigator.clipboard.writeText(term.getSelection())
      return false
    }
    return false
  })
}

function readOnlyViewOptions(options: ITerminalOptions): ITerminalOptions {
  const settings = useSettingsStore.getState().terminal
  return {
    scrollSensitivity: settings.scrollSpeed,
    minimumContrastRatio: settings.minimumContrast,
    cursorInactiveStyle: 'none',
    ...options,
  }
}

export function mountSizedReadOnlyTerminal(
  host: HTMLElement,
  size: { cols: number; rows: number },
  options: ITerminalOptions,
): MountedReadOnlyTerminal {
  const term = createReadOnlyTerminal(readOnlyViewOptions({ ...size, ...options }))
  wireReadOnly(term)
  term.open(host)
  return { term, dispose: () => term.dispose() }
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
