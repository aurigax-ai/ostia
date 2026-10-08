import { MoonIcon, PlayIcon } from '@phosphor-icons/react'
import type { AgentResume } from '@shared/agentResume'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { useEffect, useRef } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { matchChordInTerminal } from '../lib/chords'
import { smartClipboardAction } from '../lib/clipboardKeys'
import { wakePane } from '../lib/hibernationScheduler'
import {
  type ReadOnlyTerminal,
  createReadOnlyTerminal,
  useReadOnlyTerminalBackground,
  useReadOnlyTerminalFont,
} from '../lib/readOnlyTerminal'
import { isMac } from '../platform'
import { useSettingsStore } from '../stores/settingsStore'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

function wantsCopy(e: KeyboardEvent, hasSelection: boolean): boolean {
  const clipboardKeys = useSettingsStore.getState().terminal.clipboardKeys
  if (smartClipboardAction(e, clipboardKeys, hasSelection, isMac) === 'copy') return true
  return matchChordInTerminal(e, isMac) === 'copy'
}

export function HibernatedView({
  paneId,
  resume,
}: {
  paneId: string
  resume?: AgentResume
}): JSX.Element {
  const d = useDict()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<ReadOnlyTerminal | null>(null)
  const background = useReadOnlyTerminalBackground(termRef)
  useReadOnlyTerminalFont(termRef)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminalSettings = useSettingsStore.getState().terminal
    const term = createReadOnlyTerminal({
      scrollSensitivity: terminalSettings.scrollSpeed,
      minimumContrastRatio: terminalSettings.minimumContrast,
      cursorInactiveStyle: 'none',
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
      fit.fit()
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

  return (
    <div className="hibernated-view" data-hibernated="">
      <div ref={hostRef} className="xterm-host hibernated-screen" style={{ background }} />
      <div className="hibernated-mark">
        <Badge variant="outline" className="bg-bg text-fg-muted text-ui-xs">
          <MoonIcon aria-hidden />
          {d.pane.asleep}
        </Badge>
        {resume ? (
          <Button variant="outline" size="sm" onClick={() => wakePane(paneId)}>
            <PlayIcon data-icon="inline-start" aria-hidden />
            {fmt(d.pane.resume, { agent: resume.agent })}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
