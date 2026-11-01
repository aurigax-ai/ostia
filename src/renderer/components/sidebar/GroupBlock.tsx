import {
  CaretDownIcon,
  CaretRightIcon,
  ChecksIcon,
  PaletteIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import {
  WORKSPACE_GROUP_COLORS,
  type WorkspaceGroupColor,
} from '@shared/workspaces/workspaceGroups'
import { type JSX, useContext } from 'react'
import { IconButton } from '@/components/common/IconButton'
import {
  MenuContent,
  MenuItem,
  MenuRadioItem,
  MenuSubContent,
  MenuSubTrigger,
} from '@/components/common/Menu'
import { RenameInput } from '@/components/common/RenameInput'
import {
  ContextMenu,
  ContextMenuRadioGroup,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { fmt, useDict } from '@/lib/app/useDict'
import { useFlipped } from '@/lib/app/useFlipped'
import { markWorkspaceRead } from '@/lib/attention/workspaceActivity'
import type { WorkspaceGroup } from '@/lib/sidebar/workspaceGroups'
import { cn } from '@/lib/utils'
import { startNewWorkspace } from '@/lib/workspaces/newWorkspace'
import { useUIStore } from '@/stores/app/uiStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { GroupStatus, GroupUnreadDot } from './GroupStatus'
import { HibernateMenuItems } from './HibernateMenuItems'
import { RailCollapsedContext } from './RailTab'
import { type DragHandlers, GROUP_DND, isRailDrag, upperHalf } from './railDrag'

const NO_COLOR = 'none'

export function GroupBlock({
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
  const collapsed = useContext(RailCollapsedContext)
  const addWorkspace = (): void => {
    useUIStore.getState().showWorkspaces()
    startNewWorkspace({ groupId: group.id })
  }
  const revealing = useFlipped({ members: !group.collapsed }).has('members')
  const caretClass = cn('rail-group-caret', !group.collapsed && 'open')

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
            const top = upperHalf(e)
            const groupDrag = e.dataTransfer.types.includes(GROUP_DND)
            drag.over({
              kind: 'group',
              id: group.id,
              place: top ? 'before' : groupDrag ? 'after' : 'inside',
            })
          }}
          onDragEnd={drag.end}
        >
          {renaming ? (
            <span className="rail-group-main">
              <CaretRightIcon size={16} className={caretClass} aria-hidden />
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
              <CaretRightIcon size={16} className={caretClass} aria-hidden />
              <span className="rail-group-swatch" aria-hidden />
              <GroupUnreadDot workspaceIds={members.map((w) => w.id)} />
              <span className="rail-group-name">{group.name}</span>
              {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label names the block for screen readers and tests; a role would change how it is announced */}
              <span
                className="rail-group-count"
                aria-label={fmt(d.rail.groupCount, { n: members.length })}
              >
                {members.length}
              </span>
              <GroupStatus members={members} />
            </button>
          )}
          {renaming || collapsed ? null : (
            <span className="rail-group-actions">
              <IconButton
                icon={PlusIcon}
                label={d.rail.newWorkspaceInGroup}
                hintSide="right"
                onClick={addWorkspace}
              />
            </span>
          )}
        </ContextMenuTrigger>
        <GroupMenu
          group={group}
          members={members}
          onAdd={addWorkspace}
          onToggle={toggle}
          onRenaming={onRenaming}
        />
      </ContextMenu>
      {group.collapsed ? null : (
        <div className={cn('rail-group-members', revealing && 'motion-reveal')}>{children}</div>
      )}
    </div>
  )
}

function GroupMenu({
  group,
  members,
  onAdd,
  onToggle,
  onRenaming,
}: {
  group: WorkspaceGroup
  members: Workspace[]
  onAdd: () => void
  onToggle: () => void
  onRenaming: (on: boolean) => void
}): JSX.Element {
  const d = useDict()
  const store = useWorkspacesStore.getState
  return (
    <MenuContent>
      <MenuItem icon={PlusIcon} onClick={onAdd}>
        {d.rail.newWorkspaceInGroup}
      </MenuItem>
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
      <MenuItem icon={group.collapsed ? CaretRightIcon : CaretDownIcon} onClick={onToggle}>
        {group.collapsed ? d.rail.expandGroup : d.rail.collapseGroup}
      </MenuItem>
      <MenuItem icon={ChecksIcon} onClick={() => markGroupRead(members)}>
        {d.rail.markRead}
      </MenuItem>
      <HibernateMenuItems workspaceIds={members.map((w) => w.id)} />
      <ContextMenuSeparator />
      <MenuItem icon={TrashIcon} onClick={() => store().deleteGroup(group.id)}>
        {d.rail.deleteGroup}
      </MenuItem>
    </MenuContent>
  )
}

function markGroupRead(members: Workspace[]): void {
  for (const w of members) markWorkspaceRead(w.id)
}
