import {
  Bot,
  Boxes,
  FlaskConical,
  FolderTree,
  type LucideIcon,
  Plus,
  Settings,
  Terminal,
  X,
} from 'lucide-react'
import type { Dict } from '../i18n/dict'
import { useDict } from '../i18n/useDict'
import {
  type Session,
  type SessionKind,
  type SessionState,
  useSessionsStore,
} from '../stores/sessionsStore'
import { useUIStore } from '../stores/uiStore'
import { FilesView } from './FilesView'
import { Hint } from './Hint'
import { IconButton } from './IconButton'

const KIND_ICON: Record<SessionKind, LucideIcon> = {
  agent: Bot,
  terminal: Terminal,
  scratch: FlaskConical,
}

export function DeckRail(): JSX.Element {
  const d = useDict()
  const collapsed = useUIStore((s) => s.railCollapsed)
  const view = useUIStore((s) => s.sidebarView)
  const setView = useUIStore((s) => s.setSidebarView)

  return (
    <aside className={`deck-rail${collapsed ? ' collapsed' : ''}`}>
      <div className="rail-switch">
        <IconButton
          size="bar"
          hintSide="right"
          icon={Boxes}
          label={d.rail.sessions}
          aria-pressed={view === 'sessions'}
          onClick={() => setView('sessions')}
        />
        <IconButton
          size="bar"
          hintSide="right"
          icon={FolderTree}
          label={d.rail.files}
          aria-pressed={view === 'files'}
          onClick={() => setView('files')}
        />
      </div>

      {view === 'sessions' ? <SessionsView /> : <FilesView />}
    </aside>
  )
}

function SessionsView(): JSX.Element {
  const d = useDict()
  const sessions = useSessionsStore((s) => s.sessions)
  const activeId = useSessionsStore((s) => s.activeSessionId)
  const setActive = useSessionsStore((s) => s.setActive)
  const addSession = useSessionsStore((s) => s.addSession)
  const closeSession = useSessionsStore((s) => s.closeSession)
  const settingsTabOpen = useUIStore((s) => s.settingsTabOpen)
  const settingsActive = useUIStore((s) => s.settingsActive)
  const openSettings = useUIStore((s) => s.openSettings)
  const closeSettings = useUIStore((s) => s.closeSettings)
  const leaveSettings = useUIStore((s) => s.leaveSettings)

  return (
    <>
      <div className="sessions">
        {settingsTabOpen ? (
          <TabRow
            active={settingsActive}
            onSelect={openSettings}
            onClose={closeSettings}
            closeLabel={d.rail.close}
            icon={<Settings size={14} className="tab-lead" />}
            title={d.topbar.settings}
          />
        ) : null}

        {sessions.map((s) => (
          <TabRow
            key={s.id}
            active={!settingsActive && s.id === activeId}
            onSelect={() => {
              leaveSettings()
              setActive(s.id)
            }}
            onClose={() => closeSession(s.id)}
            closeLabel={d.rail.close}
            icon={<SessionIcon session={s} />}
            title={s.name}
            meta={
              <span className="tab-meta">
                <span className="tab-branch">{s.workDir}</span>
              </span>
            }
          />
        ))}
      </div>

      <Hint label={d.rail.newSession} side="right">
        <button
          type="button"
          className="rail-add"
          onClick={() => {
            leaveSettings()
            addSession()
          }}
        >
          <Plus size={14} />
          <span>{d.rail.newSession}</span>
        </button>
      </Hint>
    </>
  )
}

function stateLabel(d: Dict, state: SessionState): string {
  const labels: Record<SessionState, string> = {
    idle: d.rail.stateIdle,
    working: d.rail.stateWorking,
    waiting: d.rail.stateWaiting,
    done: d.rail.stateDone,
  }
  return labels[state]
}

function SessionIcon({ session }: { session: Session }): JSX.Element {
  const d = useDict()
  const KindIcon = KIND_ICON[session.kind]
  return (
    <span className="tab-lead-wrap">
      <span
        className={`dot session-dot ${session.state}`}
        role="img"
        aria-label={stateLabel(d, session.state)}
      />
      <KindIcon size={14} className="tab-lead" />
    </span>
  )
}

function TabRow({
  active,
  onSelect,
  onClose,
  closeLabel,
  icon,
  title,
  meta,
}: {
  active: boolean
  onSelect: () => void
  onClose: () => void
  closeLabel: string
  icon: React.ReactNode
  title: string
  meta?: React.ReactNode
}): JSX.Element {
  return (
    <div className={`rail-tab${active ? ' active' : ''}`}>
      <button type="button" className="rail-tab-main" onClick={onSelect}>
        {icon}
        <span className="tab-body">
          <span className="tab-title">{title}</span>
          {meta}
        </span>
      </button>
      <span className="tab-actions">
        <IconButton icon={X} label={closeLabel} hintSide="right" onClick={onClose} />
      </span>
    </div>
  )
}
