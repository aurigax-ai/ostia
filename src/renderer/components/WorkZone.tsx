import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useUIStore } from '../stores/uiStore'
import { PaneTree } from './PaneTree'
import { SettingsPanel } from './SettingsPanel'
import { SurfacePool } from './SurfacePool'

/**
 * The center column. Every session visited so far stays MOUNTED and stacked (the cmux
 * model): switching sessions flips visibility, it never unmounts — so ptys + xterm
 * scrollback survive, and panes never re-fit/collapse on switch. Settings overlays on top.
 */
export function WorkZone(): JSX.Element {
  const sessions = useSessionsStore((s) => s.sessions)
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const settingsActive = useUIStore((s) => s.settingsActive)
  const ensure = useLayoutStore((s) => s.ensure)
  const [mounted, setMounted] = useState<string[]>(() => [activeSessionId])

  // Lazily mount a session's tree on first visit, then keep it alive.
  useEffect(() => {
    if (!activeSessionId) return
    ensure(activeSessionId)
    setMounted((m) => (m.includes(activeSessionId) ? m : [...m, activeSessionId]))
  }, [activeSessionId, ensure])

  // Drop closed sessions from the mounted set so it doesn't grow unbounded.
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
      {/* Long-lived terminals/editors, portaled into the pane slots above (mount-once). */}
      <SurfacePool />
      <SettingsPanel />
    </section>
  )
}

/**
 * One session's pane tree, kept mounted for the session's lifetime. Inactive layers are
 * hidden with `visibility:hidden` (keeps their box size so xterm's FitAddon stays correct
 * — no re-fit needed on switch) and marked `inert` so focus can't reach them.
 */
function SessionLayer({ sessionId, active }: { sessionId: string; active: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Layout effect (not passive) so inert is cleared BEFORE Settings restores focus to a
  // terminal in this layer — otherwise focus restoration lands on an inert node.
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
