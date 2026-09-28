import { Plus } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { chordLabel } from '../lib/chords'
import { isMac } from '../platform'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useUIStore } from '../stores/uiStore'
import { PaneTree } from './PaneTree'
import { SettingsPanel } from './SettingsPanel'
import { SurfacePool } from './SurfacePool'
import { Button } from './ui/button'

const NEW_SESSION_KEYS = chordLabel('session.new', isMac)

export function WorkZone(): JSX.Element {
  const sessions = useSessionsStore((s) => s.sessions)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const settingsActive = useUIStore((s) => s.settingsActive)
  const ensure = useLayoutStore((s) => s.ensure)
  const [mounted, setMounted] = useState<string[]>(() => (activeSessionId ? [activeSessionId] : []))

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
      {sessions.length === 0 ? <NoSessions /> : null}
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

function NoSessions(): JSX.Element {
  const d = useDict()
  const addSession = useSessionsStore((s) => s.addSession)
  const leaveSettings = useUIStore((s) => s.leaveSettings)
  return (
    <div className="workzone-empty">
      <h2 className="font-semibold text-fg text-ui-lg">{d.workzone.emptyTitle}</h2>
      <p className="text-fg-muted text-ui-base">{d.workzone.emptyBody}</p>
      <Button
        className="mt-2"
        onClick={() => {
          leaveSettings()
          addSession()
        }}
      >
        <Plus data-icon="inline-start" />
        {d.rail.newSession}
        <kbd className="workzone-empty-kbd">{NEW_SESSION_KEYS}</kbd>
      </Button>
    </div>
  )
}
