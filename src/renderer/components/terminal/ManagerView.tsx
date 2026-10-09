import { useDict } from '@/i18n/useDict'
import {
  type ReadOnlyTerminal,
  createReadOnlyTerminal,
  useReadOnlyTerminalBackground,
} from '@/lib/readOnlyTerminal'
import { useEffect, useRef, useState } from 'react'

export function ManagerView({ paneId }: { paneId: string }): JSX.Element {
  const d = useDict()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<ReadOnlyTerminal | null>(null)
  const [ended, setEnded] = useState(false)
  const background = useReadOnlyTerminalBackground(termRef)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = createReadOnlyTerminal({ cursorBlink: false })
    termRef.current = term
    term.open(host)
    let disposed = false
    const pending: string[] = []
    let replayed = false
    const offData = window.ostia.pty.onData(paneId, (data) => {
      if (replayed) term.write(data)
      else pending.push(data)
    })
    const offSize = window.ostia.pty.onSize(paneId, (cols, rows) => term.resize(cols, rows))
    const offExit = window.ostia.pty.onExit(paneId, () => setEnded(true))
    window.ostia.pty
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
      window.ostia.pty.detach(paneId)
      term.dispose()
      termRef.current = null
    }
  }, [paneId])

  return (
    <div className="terminal-surface">
      <output className="manager-notice">{ended ? d.manager.ended : d.manager.readOnly}</output>
      <div className="terminal-stack">
        <div ref={hostRef} className="xterm-host manager-host" style={{ background }} />
      </div>
    </div>
  )
}
