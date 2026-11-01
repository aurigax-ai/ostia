import { useEffect, useRef, useState } from 'react'
import { StatusLine } from '@/components/common/StatusLine'
import { useDict } from '@/lib/app/useDict'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import { ghosttyModule, loadGhostty } from '@/lib/terminal/ghosttyEngine'
import { TERMINAL_INPUT_SELECTOR } from '@/lib/terminal/ostiaTerminal'
import {
  createReadOnlyTerminal,
  type ReadOnlyTerminal,
  useReadOnlyTerminalBackground,
} from '@/lib/terminal/readOnlyTerminal'
import { initialTerminalOptions } from './useTerminalOptions'

const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta'])

export function ManagerView({ paneId }: { paneId: string }): JSX.Element {
  const d = useDict()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<ReadOnlyTerminal | null>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [ended, setEnded] = useState(false)
  const [hint, setHint] = useState<'idle' | 'shown' | 'dismissed'>('idle')
  const background = useReadOnlyTerminalBackground(termRef)
  useSurfaceFocus(
    paneId,
    () => hostRef.current?.querySelector<HTMLElement>(TERMINAL_INPUT_SELECTOR) ?? null,
  )

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const onKey = (event: KeyboardEvent): void => {
      if (!MODIFIER_KEYS.has(event.key)) setHint((now) => (now === 'idle' ? 'shown' : now))
    }
    surface.addEventListener('keydown', onKey, true)
    return () => surface.removeEventListener('keydown', onKey, true)
  }, [])

  const [engineReady, setEngineReady] = useState(() => ghosttyModule() !== null)
  useEffect(() => {
    if (engineReady) return
    let live = true
    loadGhostty().then(
      () => live && setEngineReady(true),
      () => live && setEnded(true),
    )
    return () => {
      live = false
    }
  }, [engineReady])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !engineReady) return
    const term = createReadOnlyTerminal({ ...initialTerminalOptions(), cursorBlink: false })
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
  }, [paneId, engineReady])

  return (
    <div ref={surfaceRef} className="terminal-surface">
      {ended ? (
        <StatusLine>{d.manager.ended}</StatusLine>
      ) : hint === 'shown' ? (
        <StatusLine onDismiss={() => setHint('dismissed')}>{d.manager.readOnly}</StatusLine>
      ) : null}
      <div className="terminal-stack">
        <div ref={hostRef} className="ghostty-host manager-host" style={{ background }} />
      </div>
    </div>
  )
}
