import {
  FlaskIcon,
  FolderSimpleIcon,
  GearSixIcon,
  type Icon as IconComponent,
  PlusIcon,
  RobotIcon,
  StackIcon,
  TerminalWindowIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { allPanes, paneIds } from '../layout/tree'
import { latestWaitingAt, unreadCount } from '../lib/attention'
import { latestAttentionMessage, runningTitle } from '../lib/workspaceSummary'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import {
  type Workspace,
  type WorkspaceKind,
  type WorkspaceState,
  useWorkspacesStore,
} from '../stores/workspacesStore'
import { FilesView } from './FilesView'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { extensionIcon } from './extensionIcons'

const KIND_ICON: Record<WorkspaceKind, IconComponent> = {
  agent: RobotIcon,
  terminal: TerminalWindowIcon,
  scratch: FlaskIcon,
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
          icon={StackIcon}
          label={d.rail.workspaces}
          aria-pressed={view === 'workspaces'}
          onClick={() => setView('workspaces')}
        />
        <IconButton
          size="bar"
          hintSide="right"
          icon={FolderSimpleIcon}
          label={d.rail.files}
          aria-pressed={view === 'files'}
          onClick={() => setView('files')}
        />
      </div>

      {view === 'workspaces' ? <WorkspacesView /> : <FilesView />}
    </aside>
  )
}

function WorkspacesView(): JSX.Element {
  const d = useDict()
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const activeId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const setActive = useWorkspacesStore((s) => s.setActive)
  const addWorkspace = useWorkspacesStore((s) => s.addWorkspace)
  const closeWorkspace = useWorkspacesStore((s) => s.closeWorkspace)
  const rename = useWorkspacesStore((s) => s.rename)
  const settingsTabOpen = useUIStore((s) => s.settingsTabOpen)
  const settingsActive = useUIStore((s) => s.settingsActive)
  const openSettings = useUIStore((s) => s.openSettings)
  const closeSettings = useUIStore((s) => s.closeSettings)
  const leaveSettings = useUIStore((s) => s.leaveSettings)

  return (
    <>
      <div className="workspaces">
        {settingsTabOpen ? (
          <TabRow
            active={settingsActive}
            onSelect={openSettings}
            onClose={closeSettings}
            closeLabel={d.rail.close}
            icon={<GearSixIcon size={14} className="tab-lead" />}
            title={d.topbar.settings}
          />
        ) : null}

        {workspaces.map((s) => (
          <TabRow
            key={s.id}
            active={!settingsActive && s.id === activeId}
            onSelect={() => {
              leaveSettings()
              setActive(s.id)
            }}
            onClose={() => closeWorkspace(s.id)}
            closeLabel={d.rail.close}
            icon={<WorkspaceIcon workspace={s} />}
            title={s.customName ?? s.name}
            onRename={(name) => rename(s.id, name)}
            renameLabel={d.rail.renameWorkspace}
            meta={
              <>
                <WorkspaceSubtitle workspaceId={s.id} />
                <span className="tab-meta">
                  <span className="tab-branch">{s.workDir}</span>
                  <SidebarItems workspaceId={s.id} />
                </span>
              </>
            }
            badge={<UnreadBadge workspaceId={s.id} />}
          />
        ))}
      </div>

      <SidebarFooter />

      <Hint label={d.rail.newWorkspace} side="right">
        <button
          type="button"
          className="rail-add"
          onClick={() => {
            leaveSettings()
            addWorkspace()
          }}
        >
          <PlusIcon size={14} />
          <span>{d.rail.newWorkspace}</span>
        </button>
      </Hint>
    </>
  )
}

function SidebarItems({ workspaceId }: { workspaceId?: string }): JSX.Element | null {
  const all = useExtensionsStore((s) => s.sidebar)
  const items = all.filter((i) => i.workspaceId === workspaceId)
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
  const hasGlobal = useExtensionsStore((s) => s.sidebar.some((i) => i.workspaceId === undefined))
  if (!hasGlobal) return null
  return (
    <div className="rail-ext-footer">
      <SidebarItems />
    </div>
  )
}

function stateLabel(d: Dict, state: WorkspaceState): string {
  const labels: Record<WorkspaceState, string> = {
    idle: d.rail.stateIdle,
    working: d.rail.stateWorking,
    waiting: d.rail.stateWaiting,
    done: d.rail.stateDone,
    error: d.rail.stateError,
  }
  return labels[state]
}

function WorkspaceIcon({ workspace }: { workspace: Workspace }): JSX.Element {
  const d = useDict()
  const KindIcon = KIND_ICON[workspace.kind]
  const root = useLayoutStore((s) => s.byWorkspace[workspace.id]?.root)
  const waitingAt = useAttentionStore((s) => (root ? latestWaitingAt(s.byPane, paneIds(root)) : 0))
  return (
    <span className="tab-lead-wrap">
      <span
        key={workspace.state === 'waiting' ? `waiting-${waitingAt}` : 'steady'}
        className={`dot workspace-dot ${workspace.state}`}
        role="img"
        aria-label={stateLabel(d, workspace.state)}
      />
      <KindIcon size={14} className="tab-lead" />
    </span>
  )
}

function UnreadBadge({ workspaceId }: { workspaceId: string }): JSX.Element | null {
  const d = useDict()
  const root = useLayoutStore((s) => s.byWorkspace[workspaceId]?.root)
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

function WorkspaceSubtitle({ workspaceId }: { workspaceId: string }): JSX.Element | null {
  const layout = useLayoutStore((s) => s.byWorkspace[workspaceId])
  const panes = layout ? allPanes(layout.root) : []
  const message = useAttentionStore((s) => latestAttentionMessage(panes, s.byPane))
  const title = useBlocksStore((s) => runningTitle(panes, layout?.activePaneId, s.running))
  const text = message ?? title
  if (!text) return null
  return <span className={`tab-subtitle${message ? ' unread' : ''}`}>{text}</span>
}

function RenameInput({
  value,
  label,
  onDone,
}: {
  value: string
  label: string
  onDone: (name: string | null) => void
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.select(), [])
  return (
    <input
      ref={input}
      className="tab-rename"
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onDone(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(draft)
        if (e.key === 'Escape') onDone(null)
      }}
    />
  )
}

function TabRow({
  active,
  onSelect,
  onClose,
  closeLabel,
  icon,
  title,
  onRename,
  renameLabel,
  meta,
  badge,
}: {
  active: boolean
  onSelect: () => void
  onClose: () => void
  closeLabel: string
  icon: React.ReactNode
  title: string
  onRename?: (name: string) => void
  renameLabel?: string
  meta?: React.ReactNode
  badge?: React.ReactNode
}): JSX.Element {
  const [renaming, setRenaming] = useState(false)
  if (renaming && onRename) {
    return (
      <div className={`rail-tab${active ? ' active' : ''}`}>
        <span className="rail-tab-main">
          {icon}
          <RenameInput
            value={title}
            label={renameLabel ?? title}
            onDone={(name) => {
              setRenaming(false)
              if (name !== null) onRename(name)
            }}
          />
        </span>
      </div>
    )
  }
  return (
    <div className={`rail-tab${active ? ' active' : ''}`}>
      <button
        type="button"
        className="rail-tab-main"
        onClick={onSelect}
        onDoubleClick={onRename ? () => setRenaming(true) : undefined}
      >
        {icon}
        <span className="tab-body">
          <span className="tab-title">{title}</span>
          {meta}
        </span>
        {badge}
      </button>
      <span className="tab-actions">
        <IconButton icon={XIcon} label={closeLabel} hintSide="right" onClick={onClose} />
      </span>
    </div>
  )
}
