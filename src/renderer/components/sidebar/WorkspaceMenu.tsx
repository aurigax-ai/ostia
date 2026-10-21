import {
  AppWindowIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ChecksIcon,
  EraserIcon,
  FolderSimpleIcon,
  FolderSimpleMinusIcon,
  FolderSimplePlusIcon,
  GearSixIcon,
  PencilSimpleIcon,
  PushPinIcon,
  PushPinSlashIcon,
  ShieldCheckIcon,
  TextAlignLeftIcon,
  XIcon,
  XSquareIcon,
} from '@phosphor-icons/react'
import {
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuSubContent,
  MenuSubTrigger,
} from '@/components/common/Menu'
import { ContextMenuSeparator, ContextMenuSub } from '@/components/ui/context-menu'
import { useDict } from '@/lib/app/useDict'
import { markWorkspaceRead } from '@/lib/attention/workspaceActivity'
import { moveWorkspaceBy, type WorkspaceGroup } from '@/lib/sidebar/workspaceGroups'
import { requestCloseOthers, requestCloseWorkspace } from '@/lib/workspaces/closeConfirm'
import { moveWorkspaceToNewWindow } from '@/lib/workspaces/windowHandoff'
import {
  anchorToFocusedPane,
  canMoveWorkspace,
  focusedDir,
} from '@/lib/workspaces/workspaceProjects'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { Workspace } from '@/stores/workspaces/workspaceTypes'
import { HibernateMenuItems } from './HibernateMenuItems'
import { MergeMenuItems } from './MergeMenuItems'

function canMove(
  s: { workspaces: Workspace[]; groups: WorkspaceGroup[] },
  id: string,
  delta: number,
): boolean {
  const g = { workspaces: s.workspaces, groups: s.groups }
  return moveWorkspaceBy(g, id, delta) !== g
}

export function WorkspaceMenu({
  workspace: w,
  sandboxed,
  locked,
  onEdit,
  onGroupCreated,
}: {
  workspace: Workspace
  sandboxed: boolean
  locked: boolean
  onEdit: (field: 'name' | 'description') => void
  onGroupCreated: (groupId: string) => void
}): JSX.Element {
  const d = useDict()
  const store = useWorkspacesStore.getState
  const count = useWorkspacesStore((s) => s.workspaces.length)
  const groups = useWorkspacesStore((s) => s.groups)
  const canMoveUp = useWorkspacesStore((s) => canMove(s, w.id, -1))
  const canMoveDown = useWorkspacesStore((s) => canMove(s, w.id, 1))
  const otherGroups = groups.filter((g) => g.id !== w.groupId)
  return (
    <MenuContent>
      <MenuItem icon={PencilSimpleIcon} onClick={() => onEdit('name')}>
        {d.rail.rename}
      </MenuItem>
      <MenuItem icon={TextAlignLeftIcon} onClick={() => onEdit('description')}>
        {w.description ? d.rail.editDescription : d.rail.addDescription}
      </MenuItem>
      <MenuItem
        icon={FolderSimpleIcon}
        disabled={!canMoveWorkspace(w.id) || focusedDir(w.id) === null}
        onClick={() => void anchorToFocusedPane(w.id)}
      >
        {d.rail.useFocusedFolder}
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
      <HibernateMenuItems workspaceIds={[w.id]} />
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
  )
}
