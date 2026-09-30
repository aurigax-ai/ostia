import { cn } from '@/lib/utils'
import {
  FlaskIcon,
  GearSixIcon,
  type Icon as IconComponent,
  PushPinSimpleIcon,
  RobotIcon,
  TerminalWindowIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { allPanes, paneIds } from '../layout/tree'
import { latestWaitingAt, unreadCount } from '../lib/attention'
import { requestCloseOthers, requestCloseWorkspace } from '../lib/closeConfirm'
import { openSidebarUrl, visibleSidebarItems } from '../lib/sidebarItems'
import { markWorkspaceRead } from '../lib/workspaceActivity'
import { latestAttentionMessage, runningTitle } from '../lib/workspaceSummary'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import {
  type Workspace,
  type WorkspaceKind,
  type WorkspaceState,
  useWorkspacesStore,
} from '../stores/workspacesStore'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { ATTENTION_BADGE } from './attentionStyles'
import { extensionIcon } from './extensionIcons'
import { Badge } from './ui/badge'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './ui/context-menu'
import { Input } from './ui/input'
import { Kbd } from './ui/kbd'

const KIND_ICON: Record<WorkspaceKind, IconComponent> = {
  agent: RobotIcon,
  terminal: TerminalWindowIcon,
  scratch: FlaskIcon,
}

export function DeckRail(): JSX.Element {
  const collapsed = useUIStore((s) => s.railCollapsed)
  return (
    <aside className={`deck-rail${collapsed ? ' collapsed' : ''}`}>
      <WorkspacesView />
    </aside>
  )
}

function WorkspacesView(): JSX.Element {
  const d = useDict()
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const activeId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const [drag, setDrag] = useState<WorkspaceDrag | null>(null)
  const settingsTabOpen = useUIStore((s) => s.settingsTabOpen)
  const settingsActive = useUIStore((s) => s.settingsActive)
  const openSettings = useUIStore((s) => s.openSettings)
  const closeSettings = useUIStore((s) => s.closeSettings)

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

        {workspaces.map((w, index) => (
          <WorkspaceRow
            key={w.id}
            workspace={w}
            index={index}
            active={!settingsActive && w.id === activeId}
            drop={drag?.overId === w.id ? drag.place : null}
            onDragStart={() => setDrag({ id: w.id, overId: null, place: 'before' })}
            onDragOverRow={(place) =>
              setDrag((cur) =>
                cur && (cur.overId !== w.id || cur.place !== place)
                  ? { ...cur, overId: w.id, place }
                  : cur,
              )
            }
            onDropRow={() => {
              if (drag && drag.id !== w.id) {
                useWorkspacesStore
                  .getState()
                  .moveTo(drag.id, dropIndex(workspaces, drag.id, w.id, drag.place))
              }
              setDrag(null)
            }}
            onDragEnd={() => setDrag(null)}
          />
        ))}
      </div>

      <SidebarFooter />
    </>
  )
}

function SidebarItems({ workspaceId }: { workspaceId?: string }): JSX.Element | null {
  const d = useDict()
  const all = useExtensionsStore((s) => s.sidebar)
  const showPorts = useSettingsStore((s) => s.sidebar.showPorts)
  const showSSH = useSettingsStore((s) => s.sidebar.showSSH)
  const items = visibleSidebarItems(all, workspaceId, { showPorts, showSSH })
  if (items.length === 0) return null
  return (
    <>
      {items.map((item) => {
        const Icon = item.icon ? extensionIcon(item.icon) : null
        const url = item.url
        if (url) {
          return (
            <Hint key={`${item.extId}:${item.key}`} label={fmt(d.rail.openUrl, { url })}>
              <button
                type="button"
                className={`ext-item ext-item-link tone-${item.tone}`}
                onClick={(e) => {
                  e.stopPropagation()
                  openSidebarUrl(workspaceId, url)
                }}
              >
                {Icon ? <Icon size={12} aria-hidden /> : null}
                {item.text}
              </button>
            </Hint>
          )
        }
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
    <Badge
      key={pop.generation}
      variant="outline"
      className={cn(ATTENTION_BADGE, 'unread-badge', pop.active && 'pop')}
      role="img"
      aria-label={fmt(d.rail.unread, { n })}
      onAnimationEnd={pop.end}
    >
      {n > 99 ? '99+' : n}
    </Badge>
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

interface WorkspaceDrag {
  id: string
  overId: string | null
  place: DropPlace
}

type DropPlace = 'before' | 'after'

const WORKSPACE_DND = 'application/x-pine-workspace'

function dropIndex(list: Workspace[], dragId: string, overId: string, place: DropPlace): number {
  const others = list.filter((w) => w.id !== dragId)
  const at = others.findIndex((w) => w.id === overId)
  return place === 'before' ? at : at + 1
}

function WorkspaceRow({
  workspace: w,
  index,
  active,
  drop,
  onDragStart,
  onDragOverRow,
  onDropRow,
  onDragEnd,
}: {
  workspace: Workspace
  index: number
  active: boolean
  drop: DropPlace | null
  onDragStart: () => void
  onDragOverRow: (place: DropPlace) => void
  onDropRow: () => void
  onDragEnd: () => void
}): JSX.Element {
  const sidebar = useSettingsStore((s) => s.sidebar)
  const wrapTitles = useSettingsStore((s) => s.workspaces.wrapTitles)
  const d = useDict()
  const store = useWorkspacesStore.getState
  const count = useWorkspacesStore((s) => s.workspaces.length)
  const digitHints = useUIStore((s) => s.digitHints)
  const [editing, setEditing] = useState<'name' | 'description' | null>(null)
  const title = w.customName ?? w.name
  const select = (): void => {
    useUIStore.getState().leaveSettings()
    store().setActive(w.id)
  }
  const editor =
    editing === null ? undefined : (
      <RenameInput
        value={editing === 'name' ? title : (w.description ?? '')}
        label={editing === 'name' ? d.rail.renameWorkspace : d.rail.describeWorkspace}
        onDone={(text) => {
          setEditing(null)
          if (text === null) return
          if (editing === 'name') store().rename(w.id, text)
          else store().describe(w.id, text)
        }}
      />
    )

  return (
    <ContextMenu>
      <ContextMenuTrigger
        className="rail-row"
        data-drop={drop ?? undefined}
        draggable={editing === null}
        onDragStart={(e) => {
          e.dataTransfer.setData(WORKSPACE_DND, w.id)
          e.dataTransfer.effectAllowed = 'move'
          onDragStart()
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(WORKSPACE_DND)) return
          e.preventDefault()
          const box = e.currentTarget.getBoundingClientRect()
          onDragOverRow(e.clientY < box.top + box.height / 2 ? 'before' : 'after')
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes(WORKSPACE_DND)) return
          e.preventDefault()
          onDropRow()
        }}
        onDragEnd={onDragEnd}
      >
        <TabRow
          active={active}
          onSelect={select}
          onClose={() => void requestCloseWorkspace(w.id)}
          closeLabel={d.rail.close}
          icon={<WorkspaceIcon workspace={w} />}
          title={title}
          wrapTitle={wrapTitles}
          titleAdornment={
            w.pinned ? (
              <PushPinSimpleIcon size={11} className="tab-pin" aria-label={d.rail.pinned} />
            ) : null
          }
          editor={editor}
          onDoubleClick={() => setEditing('name')}
          after={
            editing === null ? (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the row button above is the keyboard target; this only widens the click area
              <div className="tab-after" onClick={select}>
                {sidebar.showDescription && w.description ? (
                  <WorkspaceDescription text={w.description} />
                ) : null}
                {sidebar.showMessage ? <WorkspaceSubtitle workspaceId={w.id} /> : null}
                {sidebar.showPath || sidebar.showExtensionItems ? (
                  <span className="tab-meta">
                    {sidebar.showPath ? <span className="tab-branch">{w.workDir}</span> : null}
                    {sidebar.showExtensionItems ? <SidebarItems workspaceId={w.id} /> : null}
                  </span>
                ) : null}
              </div>
            ) : null
          }
          badge={
            digitHints && index < 9 ? (
              <Kbd className="tab-digit font-mono">{index + 1}</Kbd>
            ) : (
              <UnreadBadge workspaceId={w.id} />
            )
          }
        />
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        <ContextMenuItem onClick={() => setEditing('name')}>{d.rail.rename}</ContextMenuItem>
        <ContextMenuItem onClick={() => setEditing('description')}>
          {w.description ? d.rail.editDescription : d.rail.addDescription}
        </ContextMenuItem>
        {w.description ? (
          <ContextMenuItem onClick={() => store().describe(w.id, '')}>
            {d.rail.clearDescription}
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => store().setPinned(w.id, !w.pinned)}>
          {w.pinned ? d.rail.unpin : d.rail.pin}
        </ContextMenuItem>
        <ContextMenuItem disabled={index === 0} onClick={() => store().moveBy(w.id, -1)}>
          {d.rail.moveUp}
        </ContextMenuItem>
        <ContextMenuItem disabled={index === count - 1} onClick={() => store().moveBy(w.id, 1)}>
          {d.rail.moveDown}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => markWorkspaceRead(w.id)}>{d.rail.markRead}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={count < 2} onClick={() => void requestCloseOthers(w.id)}>
          {d.rail.closeOthers}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void requestCloseWorkspace(w.id)}>
          {d.rail.closeWorkspace}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

const DESCRIPTION_ELEMENTS = ['p', 'a', 'strong', 'em', 'code', 'del']

const DESCRIPTION_COMPONENTS: Components = {
  p: ({ node: _node, ...props }) => <span {...props} />,
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
}

function WorkspaceDescription({ text }: { text: string }): JSX.Element {
  return (
    <div className="tab-description">
      <Markdown
        allowedElements={DESCRIPTION_ELEMENTS}
        unwrapDisallowed
        components={DESCRIPTION_COMPONENTS}
      >
        {text}
      </Markdown>
    </div>
  )
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
    <Input
      ref={input}
      className="tab-rename h-6 px-1.5"
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
  titleAdornment,
  wrapTitle,
  editor,
  onDoubleClick,
  meta,
  after,
  badge,
}: {
  active: boolean
  onSelect: () => void
  onClose: () => void
  closeLabel: string
  icon: React.ReactNode
  title: string
  titleAdornment?: React.ReactNode
  wrapTitle?: boolean
  editor?: React.ReactNode
  onDoubleClick?: () => void
  meta?: React.ReactNode
  after?: React.ReactNode
  badge?: React.ReactNode
}): JSX.Element {
  if (editor) {
    return (
      <div className={`rail-tab${active ? ' active' : ''}`}>
        <span className="rail-tab-main">
          {icon}
          {editor}
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
        onDoubleClick={onDoubleClick}
      >
        {icon}
        <span className="tab-body">
          <span className="tab-title-row">
            <span className={wrapTitle ? 'tab-title wrap' : 'tab-title'}>{title}</span>
            {titleAdornment}
          </span>
          {meta}
        </span>
        {badge}
      </button>
      <span className="tab-actions">
        <IconButton icon={XIcon} label={closeLabel} hintSide="right" onClick={onClose} />
      </span>
      {after}
    </div>
  )
}
