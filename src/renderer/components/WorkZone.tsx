import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useUIStore } from '../stores/uiStore'
import { PaneTree } from './PaneTree'
import { SettingsPanel } from './SettingsPanel'
import { SurfacePool } from './SurfacePool'

export function WorkZone(): JSX.Element {
  const sessions = useSessionsStore((s) => s.sessions)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const settingsActive = useUIStore((s) => s.settingsActive)
  const ensure = useLayoutStore((s) => s.ensure)
  const [mounted, setMounted] = useState<string[]>(() => [activeSessionId])

  useEffect(() => {
    if (!activeSessionId) return
    ensure(activeSessionId)
    setMounted((m) => (m.includes(activeSessionId) ? m : [...m, activeSessionId]))
  }, [activeSessionId, ensure])

  useEffect(() => {
    setMounted((m) => {
      const alive = m.filter((id) => sessions.some((s) => s.id === id))
      return alive.length === m.length ? m : alive
    })
  }, [sessions])

  return (
    <section className="workzone relative">
      {mounted
        .filter((id) => sessions.some((s) => s.id === id))
        .map((id) => (
          <SessionLayer
            key={id}
            sessionId={id}
            active={id === activeSessionId && !settingsActive}
          />
        ))}
      <SurfacePool />
      <SettingsPanel />
    </section>
  )
}

function SessionLayer({ sessionId, active }: { sessionId: string; active: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current) ref.current.inert = !active
  }, [active])
  return (
    <div
      ref={ref}
      className="workzone-session"
      style={{ visibility: active ? 'visible' : 'hidden' }}
      aria-hidden={!active}
    >
      <PaneTree sessionId={sessionId} />
    </div>
  )
}
