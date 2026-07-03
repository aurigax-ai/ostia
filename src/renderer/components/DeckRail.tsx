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

const KIND_ICON: Record<SessionKind, LucideIcon> = {
  agent: Bot,
  terminal: Terminal,
  scratch: FlaskConical,
}

/**
 * The sidebar. A view switcher up top toggles between **Sessions** (the signature
 * status board of agent/terminal sessions) and **Files** (the explorer). Each
 * session's dot reports live state and breathes (docs/DESIGN.md).
 */
export function DeckRail(): JSX.Element {
  const d = useDict()
  const collapsed = useUIStore((s) => s.railCollapsed)
  const view = useUIStore((s) => s.sidebarView)
  const setView = useUIStore((s) => s.setSidebarView)

  return (
    <aside className={`deck-rail${collapsed ? ' collapsed' : ''}`}>
      <div className="rail-switch">
        <RailSwitchButton
          icon={Boxes}
          label={d.rail.sessions}
          active={view === 'sessions'}
          onClick={() => setView('sessions')}
        />
        <RailSwitchButton
          icon={FolderTree}
          label={d.rail.files}
          active={view === 'files'}
          onClick={() => setView('files')}
        />
      </div>

      {view === 'sessions' ? <SessionsView /> : <FilesView />}
    </aside>
  )
}

function RailSwitchButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon
  label: string
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <Hint label={label} side="right">
      <button
        type="button"
        className={`rail-switch-btn${active ? ' active' : ''}`}
        aria-pressed={active}
        onClick={onClick}
      >
        <Icon size={16} />
      </button>
    </Hint>
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
        {/* Settings: a persistent tab once opened — closes only via its ×, on top. */}
        {settingsTabOpen ? (
          <TabRow
            active={settingsActive}
            onSelect={openSettings}
            onClose={closeSettings}
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
          <Plus size={15} />
          <span>{d.rail.newSession}</span>
        </button>
      </Hint>
    </>
  )
}

const SESSION_STATE_LABEL: Record<SessionState, string> = {
  idle: 'Idle',
  working: 'Working',
  waiting: 'Waiting for input',
  done: 'Done',
}

function SessionIcon({ session }: { session: Session }): JSX.Element {
  const KindIcon = KIND_ICON[session.kind]
  return (
    <span className="tab-lead-wrap">
      <span
        className={`dot session-dot ${session.state}`}
        role="img"
        aria-label={SESSION_STATE_LABEL[session.state]}
      />
      <KindIcon size={13} className="tab-lead" />
    </span>
  )
}

/**
 * A uniform sidebar tab (Settings or a session): lead icon · title (+ optional meta),
 * with ×/⋮ actions revealed on hover. Rows are consistent height. Not a <button> so the
 * hover actions can be real buttons (no nested-button HTML).
 */
function TabRow({
  active,
  onSelect,
  onClose,
  icon,
  title,
  meta,
}: {
  active: boolean
  onSelect: () => void
  onClose: () => void
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
        <button type="button" className="tab-btn" aria-label="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </span>
    </div>
  )
}
