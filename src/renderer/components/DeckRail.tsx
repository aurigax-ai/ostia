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
import { useCallback, useState } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { paneIds } from '../layout/tree'
import { latestWaitingAt, unreadCount } from '../lib/attention'
import { useAttentionStore } from '../stores/attentionStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
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
import { extensionIcon } from './extensionIcons'

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
                <SidebarItems sessionId={s.id} />
              </span>
            }
            badge={<UnreadBadge sessionId={s.id} />}
          />
        ))}
      </div>

      <SidebarFooter />

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

function SidebarItems({ sessionId }: { sessionId?: string }): JSX.Element | null {
  const all = useExtensionsStore((s) => s.sidebar)
  const items = all.filter((i) => i.sessionId === sessionId)
  if (items.length === 0) return null
  return (
    <>
      {items.map((item) => {
        const Icon = item.icon ? extensionIcon(item.icon) : null
        return (
          <Hint key={`${item.extId}:${item.key}`} label={`${item.extId}: ${item.text}`}>
            <span className={`ext-item tone-${item.tone}`}>
              {Icon ? <Icon size={12} aria-hidden /> : null}
              {item.text}
            </span>
          </Hint>
        )
      })}
    </>
  )
}

function SidebarFooter(): JSX.Element | null {
  const hasGlobal = useExtensionsStore((s) => s.sidebar.some((i) => i.sessionId === undefined))
  if (!hasGlobal) return null
  return (
    <div className="rail-ext-footer">
      <SidebarItems />
    </div>
  )
}

function stateLabel(d: Dict, state: SessionState): string {
  const labels: Record<SessionState, string> = {
    idle: d.rail.stateIdle,
    working: d.rail.stateWorking,
    waiting: d.rail.stateWaiting,
    done: d.rail.stateDone,
    error: d.rail.stateError,
  }
  return labels[state]
}

function SessionIcon({ session }: { session: Session }): JSX.Element {
  const d = useDict()
  const KindIcon = KIND_ICON[session.kind]
  const root = useLayoutStore((s) => s.bySession[session.id]?.root)
  const waitingAt = useAttentionStore((s) => (root ? latestWaitingAt(s.byPane, paneIds(root)) : 0))
  return (
    <span className="tab-lead-wrap">
      <span
        key={session.state === 'waiting' ? `waiting-${waitingAt}` : 'steady'}
        className={`dot session-dot ${session.state}`}
        role="img"
        aria-label={stateLabel(d, session.state)}
      />
      <KindIcon size={14} className="tab-lead" />
    </span>
  )
}

function UnreadBadge({ sessionId }: { sessionId: string }): JSX.Element | null {
  const d = useDict()
  const root = useLayoutStore((s) => s.bySession[sessionId]?.root)
  const n = useAttentionStore((s) => (root ? unreadCount(s.byPane, paneIds(root)) : 0))
  const pop = usePopOnIncrease(n)
  if (n === 0) return null
  return (
    <span
      key={pop.generation}
      className={`unread-badge${pop.active ? ' pop' : ''}`}
      role="img"
      aria-label={fmt(d.rail.unread, { n })}
      onAnimationEnd={pop.end}
    >
      {n > 99 ? '99+' : n}
    </span>
  )
}

function usePopOnIncrease(n: number): { active: boolean; generation: number; end: () => void } {
  const [seen, setSeen] = useState({ n: 0, generation: 0, active: false })
  if (seen.n !== n) {
    const grew = n > seen.n
    setSeen({
      n,
      generation: grew ? seen.generation + 1 : seen.generation,
      active: grew,
    })
  }
  const end = useCallback(() => setSeen((s) => (s.active ? { ...s, active: false } : s)), [])
  return { active: seen.active, generation: seen.generation, end }
}

function TabRow({
  active,
  onSelect,
  onClose,
  closeLabel,
  icon,
  title,
  meta,
  badge,
}: {
  active: boolean
  onSelect: () => void
  onClose: () => void
  closeLabel: string
  icon: React.ReactNode
  title: string
  meta?: React.ReactNode
  badge?: React.ReactNode
}): JSX.Element {
  return (
    <div className={`rail-tab${active ? ' active' : ''}`}>
      <button type="button" className="rail-tab-main" onClick={onSelect}>
        {icon}
        <span className="tab-body">
          <span className="tab-title">{title}</span>
          {meta}
        </span>
        {badge}
      </button>
      <span className="tab-actions">
        <IconButton icon={X} label={closeLabel} hintSide="right" onClick={onClose} />
      </span>
    </div>
  )
}
