import { MoonIcon } from '@phosphor-icons/react'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { type FontWeight, Terminal as Xterm } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import { useDict } from '../i18n/useDict'
import { matchChordInTerminal } from '../lib/chords'
import { smartClipboardAction } from '../lib/clipboardKeys'
import { currentScheme, terminalTheme, useScheme } from '../lib/colorScheme'
import { terminalFontStack } from '../lib/uiFonts'
import { isMac } from '../platform'
import { useSettingsStore } from '../stores/settingsStore'
import { Badge } from './ui/badge'
import '@xterm/xterm/css/xterm.css'

function wantsCopy(e: KeyboardEvent, hasSelection: boolean): boolean {
  const clipboardKeys = useSettingsStore.getState().terminal.clipboardKeys
  if (smartClipboardAction(e, clipboardKeys, hasSelection, isMac) === 'copy') return true
  return matchChordInTerminal(e, isMac) === 'copy'
}

export function HibernatedView({ paneId }: { paneId: string }): JSX.Element {
  const d = useDict()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Xterm | null>(null)
  const font = useSettingsStore((s) => s.appearance.terminal)
  const palette = useScheme('terminal').colors

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const initial = useSettingsStore.getState().appearance.terminal
    const terminalSettings = useSettingsStore.getState().terminal
    const term = new Xterm({
      theme: terminalTheme(currentScheme('terminal').colors),
      fontFamily: terminalFontStack(initial.family),
      fontSize: initial.size,
      fontWeight: initial.weight as FontWeight,
      lineHeight: initial.lineHeight,
      scrollback: terminalSettings.scrollbackLines,
      scrollSensitivity: terminalSettings.scrollSpeed,
      minimumContrastRatio: terminalSettings.minimumContrast,
      disableStdin: true,
      cursorInactiveStyle: 'none',
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && wantsCopy(e, term.hasSelection())) {
        e.preventDefault()
        void navigator.clipboard.writeText(term.getSelection())
      }
      return false
    })
    term.open(host)
    termRef.current = term
    const refit = (): void => {
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return
      try {
        fit.fit()
      } catch {}
    }
    refit()
    const observer = new ResizeObserver(refit)
    observer.observe(host)
    let live = true
    void window.ostia.pty.stashed(paneId).then((screen) => {
      if (live && screen) term.write(screen)
    })
    return () => {
      live = false
      observer.disconnect()
      termRef.current = null
      term.dispose()
    }
  }, [paneId])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = terminalFontStack(font.family)
    term.options.fontSize = font.size
    term.options.fontWeight = font.weight as FontWeight
    term.options.lineHeight = font.lineHeight
  }, [font.family, font.size, font.weight, font.lineHeight])

  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = terminalTheme(palette)
  }, [palette])

  return (
    <div className="hibernated-view" data-hibernated="">
      <div
        ref={hostRef}
        className="xterm-host hibernated-screen"
        style={{ background: palette.background }}
      />
      <Badge variant="outline" className="hibernated-mark text-fg-muted text-ui-xs">
        <MoonIcon aria-hidden />
        {d.pane.asleep}
      </Badge>
    </div>
  )
}
