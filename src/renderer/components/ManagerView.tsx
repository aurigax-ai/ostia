import { type FontWeight, Terminal as Xterm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { currentScheme, terminalTheme, useScheme } from '../lib/colorScheme'
import { useSettingsStore } from '../stores/settingsStore'
import { fontStack } from './Terminal'

export function ManagerView({ paneId }: { paneId: string }): JSX.Element {
  const d = useDict()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Xterm | null>(null)
  const [ended, setEnded] = useState(false)
  const palette = useScheme('terminal').colors

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const font = useSettingsStore.getState().appearance.terminal
    const term = new Xterm({
      theme: terminalTheme(currentScheme('terminal').colors),
      fontFamily: fontStack(font.family),
      fontSize: font.size,
      fontWeight: font.weight as FontWeight,
      lineHeight: font.lineHeight,
      scrollback: useSettingsStore.getState().terminal.scrollbackLines,
      disableStdin: true,
      cursorBlink: false,
      allowProposedApi: true,
    })
    termRef.current = term
    term.open(host)
    let disposed = false
    const pending: string[] = []
    let replayed = false
    const offData = window.pine.pty.onData(paneId, (data) => {
      if (replayed) term.write(data)
      else pending.push(data)
    })
    const offSize = window.pine.pty.onSize(paneId, (cols, rows) => term.resize(cols, rows))
    const offExit = window.pine.pty.onExit(paneId, () => setEnded(true))
    window.pine.pty
      .attach(paneId, { cols: 0, rows: 0, role: 'observer', attachOnly: true })
      .then((res) => {
        if (disposed) return
        if (res.cols && res.rows) term.resize(res.cols, res.rows)
        else setEnded(true)
        term.write(res.buffer)
        for (const data of pending) term.write(data)
        pending.length = 0
        replayed = true
      })
      .catch(() => {
        if (!disposed) setEnded(true)
      })
    return () => {
      disposed = true
      offData()
      offSize()
      offExit()
      window.pine.pty.detach(paneId)
      term.dispose()
      termRef.current = null
    }
  }, [paneId])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(palette)
  }, [palette])

  const background = palette.background

  return (
    <div className="terminal-surface">
      <output className="manager-notice">{ended ? d.manager.ended : d.manager.readOnly}</output>
      <div className="terminal-stack">
        <div ref={hostRef} className="xterm-host manager-host" style={{ background }} />
      </div>
    </div>
  )
}
