import { useEffect } from 'react'
import type { FontWeight, OstiaTerminal, TerminalOptions } from '@/lib/terminal/ostiaTerminal'
import { currentScheme, terminalTheme } from '@/lib/theme/colorScheme'
import type { TerminalColors } from '@/lib/theme/types'
import { terminalFontStack } from '@/lib/theme/uiFonts'
import type { SurfaceFont } from '@/stores/app/settingsModel'
import { useSettingsStore } from '@/stores/app/settingsStore'

export function initialTerminalOptions(): TerminalOptions {
  const initial = useSettingsStore.getState().appearance.terminal
  const behavior = useSettingsStore.getState().behavior
  const terminalSettings = useSettingsStore.getState().terminal
  return {
    theme: terminalTheme(currentScheme('terminal').colors),
    fontFamily: terminalFontStack(initial.family),
    fontSize: initial.size,
    fontWeight: initial.weight as FontWeight,
    lineHeight: initial.lineHeight,
    cursorStyle: behavior.cursorStyle,
    cursorBlink: behavior.cursorBlink,
    scrollback: terminalSettings.scrollbackLines,
    scrollSensitivity: terminalSettings.scrollSpeed,
    smoothScrollDuration: 0,
    minimumContrastRatio: terminalSettings.minimumContrast,
    macOptionIsMeta: terminalSettings.macOptionIsMeta,
    macOptionClickForcesSelection: true,
    rescaleOverlappingGlyphs: true,
  }
}

export function useTerminalOptions({
  termRef,
  syncSizeRef,
  font,
  palette,
}: {
  termRef: { current: OstiaTerminal | null }
  syncSizeRef: { current: () => void }
  font: SurfaceFont & { lineHeight: number }
  palette: TerminalColors
}): void {
  const cursorStyle = useSettingsStore((s) => s.behavior.cursorStyle)
  const cursorBlink = useSettingsStore((s) => s.behavior.cursorBlink)
  const scrollSpeed = useSettingsStore((s) => s.terminal.scrollSpeed)
  const scrollbackLines = useSettingsStore((s) => s.terminal.scrollbackLines)
  const minimumContrast = useSettingsStore((s) => s.terminal.minimumContrast)
  const macOptionIsMeta = useSettingsStore((s) => s.terminal.macOptionIsMeta)

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = terminalFontStack(font.family)
    term.options.fontSize = font.size
    term.options.fontWeight = font.weight as FontWeight
    term.options.lineHeight = font.lineHeight
    syncSizeRef.current()
  }, [termRef, syncSizeRef, font.family, font.size, font.weight, font.lineHeight])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.cursorStyle = cursorStyle
    term.options.cursorBlink = cursorBlink
  }, [termRef, cursorStyle, cursorBlink])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = terminalTheme(palette)
  }, [termRef, palette])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.scrollSensitivity = scrollSpeed
    term.options.scrollback = scrollbackLines
    term.options.minimumContrastRatio = minimumContrast
    term.options.macOptionIsMeta = macOptionIsMeta
  }, [termRef, scrollSpeed, scrollbackLines, minimumContrast, macOptionIsMeta])
}
