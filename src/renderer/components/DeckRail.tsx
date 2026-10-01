import { cn } from '@/lib/utils'
import {
  AppWindowIcon,
  ArrowDownIcon,
  ArrowSquareInIcon,
  ArrowUpIcon,
  ArrowsMergeIcon,
  BroadcastIcon,
  CaretDownIcon,
  CaretRightIcon,
  ChecksIcon,
  EraserIcon,
  FlaskIcon,
  FolderSimpleIcon,
  FolderSimpleMinusIcon,
  FolderSimplePlusIcon,
  GearSixIcon,
  type Icon as IconComponent,
  LockSimpleIcon,
  MoonIcon,
  PaletteIcon,
  PencilSimpleIcon,
  PushPinIcon,
  PushPinSimpleIcon,
  PushPinSlashIcon,
  RobotIcon,
  ShieldCheckIcon,
  SunIcon,
  TerminalWindowIcon,
  TextAlignLeftIcon,
  TrashIcon,
  XIcon,
  XSquareIcon,
} from '@phosphor-icons/react'
import type { ExtensionSidebarItem } from '@shared/extensions'
import { WORKSPACE_GROUP_COLORS, type WorkspaceGroupColor } from '@shared/workspaceGroups'
import { useCallback, useEffect, useRef, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { allPanes, hasLockedPane, paneIds } from '../layout/tree'
import { aggregateWorkspaceState, latestWaitingAt, unreadCount } from '../lib/attention'
import { requestCloseOthers, requestCloseWorkspace } from '../lib/closeConfirm'
import {
  hibernatableAgentPanes,
  hibernateWorkspace,
  hibernatedPanes,
  wakeWorkspace,
} from '../lib/hibernationScheduler'
import { beginDrag, endWorkspaceDrag } from '../lib/paneDrag'
import { type RowDropZone, rowDropZone } from '../lib/railDropZone'
import { sidebarLines, visibleSidebarItems } from '../lib/sidebarItems'
import { moveWorkspaceToNewWindow } from '../lib/windowHandoff'
import { type RemoteWorkspace, remoteWorkspacesOf } from '../lib/windowWorkspaces'
import { markWorkspaceRead } from '../lib/workspaceActivity'
import {
  type DragSource,
  type DropTarget,
  type WorkspaceGroup,
  moveWorkspaceBy,
  toBlocks,
} from '../lib/workspaceGroups'
import { loadMergeTargets, requestMergeWorkspace } from '../lib/workspaceMerge'
import { latestAttentionMessage, runningTitle } from '../lib/workspaceSummary'
import { useAttentionStore } from '../stores/attentionStore'
import { useBlocksStore } from '../stores/blocksStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSandboxStore } from '../stores/sandboxStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWindowsStore } from '../stores/windowsStore'
import {
  type Workspace,
  type WorkspaceKind,
  type WorkspaceState,
  useWorkspacesStore,
} from '../stores/workspacesStore'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import {
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuRadioItem,
  MenuSubContent,
  MenuSubTrigger,
} from './Menu'
import { MergeMenuItems } from './MergeMenuItems'
import { LiveLine, LocationLine, SidebarItem } from './RailMeta'
import { RAIL_ID, RailResizer } from './RailResizer'
import { ViewsRail } from './ViewsRail'
import { ATTENTION_BADGE } from './attentionStyles'
import { Badge } from './ui/badge'
import {
  ContextMenu,
  ContextMenuRadioGroup,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuTrigger,
} from './ui/context-menu'
import { Input } from './ui/input'
import { Kbd } from './ui/kbd'

const KIND_ICON: Record<WorkspaceKind, IconComponent> = {
  agent: RobotIcon,
  terminal: TerminalWindowIcon,
  scratch: FlaskIcon,
  manager: BroadcastIcon,
}

const WORKSPACE_DND = 'application/x-pine-workspace'
const GROUP_DND = 'application/x-pine-workspace-group'
const NO_COLOR = 'none'
const NO_ITEMS: ExtensionSidebarItem[] = []

type RailTarget = DropTarget | { kind: 'merge'; id: string }

interface RailDrag {
  source: DragSource
  target: RailTarget | null
  mergeable: ReadonlySet<string>
}

function isRailDrag(e: React.DragEvent): boolean {
  const types = e.dataTransfer.types
  return types.includes(WORKSPACE_DND) || types.includes(GROUP_DND)
}

function sameTarget(a: RailTarget | null, b: RailTarget): boolean {
  if (!a || a.kind !== b.kind) return false
  if (a.kind === 'end' || b.kind === 'end') return true
  if (a.kind === 'merge' || b.kind === 'merge') return a.id === b.id
  return a.id === b.id && a.place === b.place
}

function dragFraction(e: React.DragEvent): number {
  const box = e.currentTarget.getBoundingClientRect()
  if (box.height > 0) return (e.clientY - box.top) / box.height
  return e.clientY < box.top ? 0 : 1
}

function upperHalf(e: React.DragEvent): boolean {
  return dragFraction(e) < 0.5
}

interface DragHandlers {
  start: (source: DragSource) => void
  over: (target: RailTarget) => void
  drop: () => void
  end: () => void
}

export function DeckRail(): JSX.Element {
  const collapsed = useUIStore((s) => s.railCollapsed)
  return (
    <>
      <aside id={RAIL_ID} className={`deck-rail${collapsed ? ' collapsed' : ''}`}>
        <WorkspacesView />
      </aside>
      <RailResizer />
    </>
  )
}

function WorkspacesView(): JSX.Element {
  const d = useDict()
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const groups = useWorkspacesStore((s) => s.groups)
  const activeId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const [drag, setDrag] = useState<RailDrag | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const settingsTabOpen = useUIStore((s) => s.settingsTabOpen)
  const settingsActive = useUIStore((s) => s.settingsActive)
  const openSettings = useUIStore((s) => s.openSettings)
  const closeSettings = useUIStore((s) => s.closeSettings)

  const handlers: DragHandlers = {
    start: (source) => {
      setDrag({ source, target: null, mergeable: new Set() })
      if (source.kind !== 'workspace') return
      void loadMergeTargets(source.id).then((targets) => {
        const mergeable = new Set(targets.filter((t) => t.refusal === null).map((t) => t.id))
        setDrag((cur) => (cur?.source === source ? { ...cur, mergeable } : cur))
      })
    },
    over: (target) =>
      setDrag((cur) => (cur && !sameTarget(cur.target, target) ? { ...cur, target } : cur)),
    drop: () => {
      const target = drag?.target
      setDrag(null)
      if (!drag || !target) return
      if (target.kind === 'merge') void requestMergeWorkspace(drag.source.id, target.id)
      else useWorkspacesStore.getState().drop(drag.source, target)
    },
    end: () => setDrag(null),
  }
  const target = drag?.target ?? null

  const row = (w: Workspace): JSX.Element => (
    <WorkspaceRow
      key={w.id}
      workspace={w}
      index={workspaces.indexOf(w)}
      active={!settingsActive && w.id === activeId}
      drop={
        target?.kind === 'merge' && target.id === w.id
          ? 'merge'
          : target?.kind === 'workspace' && target.id === w.id
            ? target.place
            : null
      }
      mergeable={drag?.mergeable.has(w.id) ?? false}
      drag={handlers}
      onGroupCreated={setRenamingGroup}
    />
  )

  return (
    <>
      <div className="workspaces">
        {settingsTabOpen ? (
          <TabRow
            active={settingsActive}
            onSelect={() => openSettings()}
            onClose={closeSettings}
            closeLabel={d.rail.close}
            icon={<GearSixIcon size={16} className="tab-lead" />}
            title={d.topbar.settings}
          />
        ) : null}

        {toBlocks({ workspaces, groups }).map((block) =>
          block.group ? (
            <GroupBlock
              key={block.group.id}
              group={block.group}
              members={block.workspaces}
              containsActive={!settingsActive && block.workspaces.some((w) => w.id === activeId)}
              drop={target?.kind === 'group' && target.id === block.group.id ? target.place : null}
              drag={handlers}
              renaming={renamingGroup === block.group.id}
              onRenaming={(on) => setRenamingGroup(on ? (block.group?.id ?? null) : null)}
            >
              {block.workspaces.map(row)}
            </GroupBlock>
          ) : (
            block.workspaces.map(row)
          ),
        )}

        <RemoteWorkspaces offset={workspaces.length} />

        {drag ? (
          <div
            className="rail-drop-end"
            data-drop={target?.kind === 'end' ? 'before' : undefined}
            onDragOver={(e) => {
              if (!isRailDrag(e)) return
              e.preventDefault()
              handlers.over({ kind: 'end' })
            }}
            onDrop={(e) => {
              if (!isRailDrag(e)) return
              e.preventDefault()
              handlers.drop()
            }}
          />
        ) : null}
      </div>

      <ViewsRail />
      <SidebarFooter />
    </>
  )
}

function GroupBlock({
  group,
  members,
  containsActive,
  drop,
  drag,
  renaming,
  onRenaming,
  children,
}: {
  group: WorkspaceGroup
  members: Workspace[]
  containsActive: boolean
  drop: 'before' | 'after' | 'inside' | null
  drag: DragHandlers
  renaming: boolean
  onRenaming: (on: boolean) => void
  children: React.ReactNode
}): JSX.Element {
  const d = useDict()
  const store = useWorkspacesStore.getState
  const toggle = (): void => store().setGroupCollapsed(group.id, !group.collapsed)
  const Caret = group.collapsed ? CaretRightIcon : CaretDownIcon

  return (
    <div
      className="rail-group"
      data-color={group.color}
      data-drop={drop === 'before' || drop === 'after' ? drop : undefined}
    >
      <ContextMenu>
        <ContextMenuTrigger
          className={cn('rail-group-head', containsActive && 'has-active')}
          data-drop={drop === 'inside' ? 'inside' : undefined}
          draggable={!renaming}
          onDragStart={(e) => {
            e.dataTransfer.setData(GROUP_DND, group.id)
            e.dataTransfer.effectAllowed = 'move'
            drag.start({ kind: 'group', id: group.id })
          }}
          onDragOver={(e) => {
            if (!isRailDrag(e)) return
            e.preventDefault()
            const top = upperHalf(e)
            const groupDrag = e.dataTransfer.types.includes(GROUP_DND)
            drag.over({
              kind: 'group',
              id: group.id,
              place: top ? 'before' : groupDrag ? 'after' : 'inside',
            })
          }}
          onDrop={(e) => {
            if (!isRailDrag(e)) return
            e.preventDefault()
            drag.drop()
          }}
          onDragEnd={drag.end}
        >
          {renaming ? (
            <span className="rail-group-main">
              <Caret size={12} className="rail-group-caret" aria-hidden />
              <span className="rail-group-swatch" aria-hidden />
              <RenameInput
                value={group.name}
                label={d.rail.groupName}
                onDone={(name) => {
                  onRenaming(false)
                  if (name !== null) store().renameGroup(group.id, name)
                }}
              />
            </span>
          ) : (
            <button
              type="button"
              className="rail-group-main"
              aria-expanded={!group.collapsed}
              onClick={toggle}
              onDoubleClick={() => onRenaming(true)}
            >
              <Caret size={12} className="rail-group-caret" aria-hidden />
              <span className="rail-group-swatch" aria-hidden />
              <UnreadBadge workspaceIds={members.map((w) => w.id)} />
              <span className="rail-group-name">{group.name}</span>
              <span
                className="rail-group-count"
                aria-label={fmt(d.rail.groupCount, { n: members.length })}
              >
                {members.length}
              </span>
              <GroupStatus members={members} />
            </button>
          )}
        </ContextMenuTrigger>
        <MenuContent>
          <MenuItem icon={PencilSimpleIcon} onClick={() => onRenaming(true)}>
            {d.rail.rename}
          </MenuItem>
          <ContextMenuSub>
            <MenuSubTrigger icon={PaletteIcon}>{d.rail.groupColor}</MenuSubTrigger>
            <MenuSubContent>
              <ContextMenuRadioGroup
                value={group.color ?? NO_COLOR}
                onValueChange={(value: string) =>
                  store().setGroupColor(
                    group.id,
                    value === NO_COLOR ? null : (value as WorkspaceGroupColor),
                  )
                }
              >
                <MenuRadioItem value={NO_COLOR}>{d.rail.noColor}</MenuRadioItem>
                {WORKSPACE_GROUP_COLORS.map((color) => (
                  <MenuRadioItem
                    key={color}
                    value={color}
                    leading={<span className="rail-color-chip" data-color={color} />}
                  >
                    {d.rail.groupColors[color]}
                  </MenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </MenuSubContent>
          </ContextMenuSub>
          <MenuItem icon={group.collapsed ? CaretRightIcon : CaretDownIcon} onClick={toggle}>
            {group.collapsed ? d.rail.expandGroup : d.rail.collapseGroup}
          </MenuItem>
          <MenuItem icon={ChecksIcon} onClick={() => markGroupRead(members)}>
            {d.rail.markRead}
          </MenuItem>
          <ContextMenuSeparator />
          <MenuItem icon={TrashIcon} onClick={() => store().deleteGroup(group.id)}>
            {d.rail.deleteGroup}
          </MenuItem>
        </MenuContent>
      </ContextMenu>
      {group.collapsed ? null : <div className="rail-group-members">{children}</div>}
    </div>
  )
}

function markGroupRead(members: Workspace[]): void {
  for (const w of members) markWorkspaceRead(w.id)
}

function GroupStatus({ members }: { members: Workspace[] }): JSX.Element | null {
  const d = useDict()
  const state = aggregateWorkspaceState(members.map((w) => w.state))
  if (state === 'idle') return null
  return (
    <span className={`dot rail-group-dot ${state}`} role="img" aria-label={stateLabel(d, state)} />
  )
}
function useSidebarItems(workspaceId: string | undefined): ExtensionSidebarItem[] {
  const all = useExtensionsStore((s) => s.sidebar)
  const showSSH = useSettingsStore((s) => s.sidebar.showSSH)
  return visibleSidebarItems(all, workspaceId, { showSSH })
}

function WorkspaceMeta({ workspace: w }: { workspace: Workspace }): JSX.Element {
  const sidebar = useSettingsStore((s) => s.sidebar)
  const items = useSidebarItems(w.id)
  const lines = sidebarLines(sidebar.showExtensionItems ? items : [])
  return (
    <>
      <LocationLine
        path={sidebar.showPath ? (w.projectDir ?? w.workDir) : undefined}
        items={lines.location}
        workspaceId={w.id}
      />
      <LiveLine items={lines.live} workspaceId={w.id} />
    </>
  )
}

function FooterItems(): JSX.Element {
  const items = useSidebarItems(undefined)
  return (
    <>
      {items.map((item) => (
        <SidebarItem key={`${item.extId}:${item.key}`} item={item} />
      ))}
    </>
  )
}

function SidebarFooter(): JSX.Element | null {
  const hasGlobal = useExtensionsStore((s) => s.sidebar.some((i) => i.workspaceId === undefined))
  if (!hasGlobal) return null
  return (
    <div className="rail-ext-footer">
      <FooterItems />
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
  const root = useLayoutStore((s) => s.byWorkspace[workspace.id]?.root)
  const hibernated = root ? allPanes(root).some((p) => p.hibernated) : false
  const KindIcon = hibernated ? MoonIcon : KIND_ICON[workspace.kind]
  const waitingAt = useAttentionStore((s) => (root ? latestWaitingAt(s.byPane, paneIds(root)) : 0))
  return (
    <span className="tab-lead-wrap">
      <span
        key={workspace.state === 'waiting' ? `waiting-${waitingAt}` : 'steady'}
        className={`dot workspace-dot ${workspace.state}`}
        role="img"
        aria-label={stateLabel(d, workspace.state)}
      />
      <UnreadBadge workspaceIds={[workspace.id]} />
      <KindIcon
        size={16}
        className="tab-lead"
        role={hibernated ? 'img' : undefined}
        aria-label={hibernated ? d.pane.hibernated : undefined}
      />
    </span>
  )
}
function ScratchBadge(): JSX.Element {
  const d = useDict()
  return (
    <Hint label={d.scratch.badgeHint}>
      <Badge variant="outline" className="scratch-badge h-4 rounded-sm px-1 text-ui-xs">
        {d.scratch.badge}
      </Badge>
    </Hint>
  )
}

function UnreadBadge({ workspaceIds }: { workspaceIds: string[] }): JSX.Element | null {
  const d = useDict()
  const byWorkspace = useLayoutStore((s) => s.byWorkspace)
  const n = useAttentionStore((s) => {
    let total = 0
    for (const id of workspaceIds) {
      const root = byWorkspace[id]?.root
      if (root) total += unreadCount(s.byPane, paneIds(root))
    }
    return total
  })
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

function WorkspaceRow({
  workspace: w,
  index,
  active,
  drop,
  mergeable,
  drag,
  onGroupCreated,
}: {
  workspace: Workspace
  index: number
  active: boolean
  drop: RowDropZone | null
  mergeable: boolean
  drag: DragHandlers
  onGroupCreated: (groupId: string) => void
}): JSX.Element {
  const sidebar = useSettingsStore((s) => s.sidebar)
  const wrapTitles = useSettingsStore((s) => s.workspaces.wrapTitles)
  const d = useDict()
  const store = useWorkspacesStore.getState
  const count = useWorkspacesStore((s) => s.workspaces.length)
  const groups = useWorkspacesStore((s) => s.groups)
  const canMoveUp = useWorkspacesStore((s) => canMove(s, w.id, -1))
  const canMoveDown = useWorkspacesStore((s) => canMove(s, w.id, 1))
  const digitHints = useUIStore((s) => s.digitHints)
  const [editing, setEditing] = useState<'name' | 'description' | null>(null)
  const title = w.customName ?? w.name
  const sandboxed = useSandboxStore((s) => s.enabled[w.id] ?? false)
  const locked = useLayoutStore((s) => {
    const root = s.byWorkspace[w.id]?.root
    return root ? hasLockedPane(root) : false
  })
  useEffect(() => {
    void useSandboxStore.getState().load(w.id)
  }, [w.id])
  const otherGroups = groups.filter((g) => g.id !== w.groupId)
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
        data-mergeable={mergeable || undefined}
        draggable={editing === null}
        onDragStart={(e) => {
          e.stopPropagation()
          e.dataTransfer.setData(WORKSPACE_DND, w.id)
          e.dataTransfer.effectAllowed = 'move'
          beginDrag(e)
          drag.start({ kind: 'workspace', id: w.id })
        }}
        onDragOver={(e) => {
          if (!isRailDrag(e)) return
          e.preventDefault()
          e.stopPropagation()
          const zone = rowDropZone(dragFraction(e), mergeable)
          drag.over(
            zone === 'merge'
              ? { kind: 'merge', id: w.id }
              : { kind: 'workspace', id: w.id, place: zone },
          )
        }}
        onDrop={(e) => {
          if (!isRailDrag(e)) return
          e.preventDefault()
          e.stopPropagation()
          drag.drop()
        }}
        onDragEnd={(e) => {
          drag.end()
          endWorkspaceDrag(w.id, e)
        }}
      >
        <TabRow
          active={active}
          onSelect={select}
          onClose={locked ? undefined : () => void requestCloseWorkspace(w.id)}
          closeLabel={d.rail.close}
          icon={<WorkspaceIcon workspace={w} />}
          title={title}
          wrapTitle={wrapTitles}
          titleAdornment={
            <>
              {w.kind === 'scratch' ? <ScratchBadge /> : null}
              {w.pinned ? (
                <PushPinSimpleIcon size={12} className="tab-pin" aria-label={d.rail.pinned} />
              ) : null}
              {locked ? (
                <LockSimpleIcon
                  size={12}
                  className="tab-lock"
                  role="img"
                  aria-label={d.rail.locked}
                />
              ) : null}
            </>
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
                <WorkspaceMeta workspace={w} />
              </div>
            ) : null
          }
          badge={digitHints && index < 9 ? <Kbd className="tab-digit">{index + 1}</Kbd> : null}
        />
        {drop === 'merge' ? (
          <output className="rail-merge-chip motion-enter">
            <ArrowsMergeIcon size={12} />
            <span className="rail-merge-chip-label text-ui-xs">
              {fmt(d.merge.menuInto, { name: title })}
            </span>
          </output>
        ) : null}
      </ContextMenuTrigger>
      <MenuContent>
        <MenuItem icon={PencilSimpleIcon} onClick={() => setEditing('name')}>
          {d.rail.rename}
        </MenuItem>
        <MenuItem icon={TextAlignLeftIcon} onClick={() => setEditing('description')}>
          {w.description ? d.rail.editDescription : d.rail.addDescription}
        </MenuItem>
        {w.description ? (
          <MenuItem icon={EraserIcon} onClick={() => store().describe(w.id, '')}>
            {d.rail.clearDescription}
          </MenuItem>
        ) : null}
        <MenuItem
          icon={GearSixIcon}
          onClick={() => useUIStore.getState().openWorkspaceSettings(w.id)}
        >
          {d.sandbox.workspaceSettings}
        </MenuItem>
        <MenuCheckboxItem
          icon={ShieldCheckIcon}
          checked={sandboxed}
          closeOnClick
          onCheckedChange={(checked) => void useSandboxStore.getState().setEnabled(w.id, checked)}
        >
          {d.rail.sandbox}
        </MenuCheckboxItem>
        <ContextMenuSeparator />
        <MenuItem
          icon={w.pinned ? PushPinSlashIcon : PushPinIcon}
          onClick={() => store().setPinned(w.id, !w.pinned)}
        >
          {w.pinned ? d.rail.unpin : d.rail.pin}
        </MenuItem>
        <MenuItem icon={ArrowUpIcon} disabled={!canMoveUp} onClick={() => store().moveBy(w.id, -1)}>
          {d.rail.moveUp}
        </MenuItem>
        <MenuItem
          icon={ArrowDownIcon}
          disabled={!canMoveDown}
          onClick={() => store().moveBy(w.id, 1)}
        >
          {d.rail.moveDown}
        </MenuItem>
        <MenuItem icon={ChecksIcon} onClick={() => markWorkspaceRead(w.id)}>
          {d.rail.markRead}
        </MenuItem>
        <HibernateMenuItems workspaceId={w.id} />
        <ContextMenuSeparator />
        <MenuItem
          icon={FolderSimplePlusIcon}
          onClick={() => {
            const groupId = store().createGroup(w.id)
            if (groupId) onGroupCreated(groupId)
          }}
        >
          {d.rail.moveToNewGroup}
        </MenuItem>
        {otherGroups.length > 0 ? (
          <ContextMenuSub>
            <MenuSubTrigger icon={FolderSimpleIcon}>{d.rail.moveToGroup}</MenuSubTrigger>
            <MenuSubContent>
              {otherGroups.map((g) => (
                <MenuItem
                  key={g.id}
                  leading={<span className="rail-color-chip" data-color={g.color} />}
                  onClick={() => store().moveToGroup(w.id, g.id)}
                >
                  {g.name}
                </MenuItem>
              ))}
            </MenuSubContent>
          </ContextMenuSub>
        ) : null}
        {w.groupId ? (
          <MenuItem icon={FolderSimpleMinusIcon} onClick={() => store().leaveGroup(w.id)}>
            {d.rail.removeFromGroup}
          </MenuItem>
        ) : null}
        <ContextMenuSeparator />
        <MenuItem icon={AppWindowIcon} onClick={() => void moveWorkspaceToNewWindow(w.id)}>
          {d.window.moveToNewWindow}
        </MenuItem>
        <MergeMenuItems workspaceId={w.id} />
        <ContextMenuSeparator />
        <MenuItem
          icon={XSquareIcon}
          disabled={count < 2}
          onClick={() => void requestCloseOthers(w.id)}
        >
          {d.rail.closeOthers}
        </MenuItem>
        <MenuItem icon={XIcon} disabled={locked} onClick={() => void requestCloseWorkspace(w.id)}>
          {d.rail.closeWorkspace}
        </MenuItem>
      </MenuContent>
    </ContextMenu>
  )
}

function HibernateMenuItems({ workspaceId }: { workspaceId: string }): JSX.Element {
  const d = useDict()
  useLayoutStore((s) => s.byWorkspace[workspaceId])
  useBlocksStore((s) => s.running)
  const sleepable = hibernatableAgentPanes(workspaceId).length > 0
  const asleep = hibernatedPanes(workspaceId).length > 0
  return (
    <>
      <MenuItem
        icon={MoonIcon}
        disabled={!sleepable}
        onClick={() => void hibernateWorkspace(workspaceId)}
      >
        {d.rail.hibernateAgents}
      </MenuItem>
      {asleep ? (
        <MenuItem icon={SunIcon} onClick={() => wakeWorkspace(workspaceId)}>
          {d.rail.wakeAgents}
        </MenuItem>
      ) : null}
    </>
  )
}

function RemoteWorkspaces({ offset }: { offset: number }): JSX.Element | null {
  const windowId = useWindowsStore((s) => s.windowId)
  const list = useWindowsStore((s) => s.list)
  const remote = remoteWorkspacesOf(list, windowId)
  if (remote.length === 0) return null
  return (
    <>
      {remote.map((w, i) => (
        <RemoteWorkspaceRow key={w.id} workspace={w} index={offset + i} />
      ))}
    </>
  )
}

function RemoteWorkspaceRow({
  workspace: w,
  index,
}: {
  workspace: RemoteWorkspace
  index: number
}): JSX.Element {
  const d = useDict()
  const digitHints = useUIStore((s) => s.digitHints)
  const show = (): void => window.pine.windows.focusWorkspace(w.id, false)
  return (
    <ContextMenu>
      <ContextMenuTrigger className="rail-row remote">
        <TabRow
          active={false}
          onSelect={show}
          closeLabel={d.rail.close}
          icon={
            <span className="tab-lead-wrap">
              <span
                className={`dot workspace-dot ${w.state}`}
                role="img"
                aria-label={stateLabel(d, w.state)}
              />
              <AppWindowIcon size={16} className="tab-lead" aria-label={d.window.inOtherWindow} />
            </span>
          }
          title={w.name}
          after={
            // biome-ignore lint/a11y/useKeyWithClickEvents: the row button above is the keyboard target; this only widens the click area
            <div className="tab-after" onClick={show}>
              <LocationLine path={w.workDir} items={NO_ITEMS} />
            </div>
          }
          badge={digitHints && index < 9 ? <Kbd className="tab-digit">{index + 1}</Kbd> : null}
        />
      </ContextMenuTrigger>
      <MenuContent>
        <MenuItem icon={AppWindowIcon} onClick={show}>
          {d.window.showWindow}
        </MenuItem>
        <MenuItem
          icon={ArrowSquareInIcon}
          onClick={() => window.pine.windows.returnWorkspace(w.id)}
        >
          {d.window.moveToMain}
        </MenuItem>
      </MenuContent>
    </ContextMenu>
  )
}

function canMove(
  s: { workspaces: Workspace[]; groups: WorkspaceGroup[] },
  id: string,
  delta: number,
): boolean {
  const g = { workspaces: s.workspaces, groups: s.groups }
  return moveWorkspaceBy(g, id, delta) !== g
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
  onClose?: () => void
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
  const collapsed = useUIStore((s) => s.railCollapsed)
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
  const main = (
    <button
      type="button"
      className="rail-tab-main"
      aria-label={collapsed ? title : undefined}
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
  )
  if (collapsed) {
    return (
      <div className={`rail-tab${active ? ' active' : ''}`}>
        <Hint label={title} side="right">
          {main}
        </Hint>
      </div>
    )
  }
  return (
    <div className={`rail-tab${active ? ' active' : ''}`}>
      {main}
      {onClose ? (
        <span className="tab-actions">
          <IconButton icon={XIcon} label={closeLabel} hintSide="right" onClick={onClose} />
        </span>
      ) : null}
      {after}
    </div>
  )
}
