import { normalizeGroupName } from '@shared/workspaces/workspaceGroups'
import {
  applyDrop,
  createGroup,
  deleteGroup,
  type Grouping,
  joinGroup,
  leaveGroup,
  moveWorkspaceBy,
  patchGroup,
  pinWorkspace,
} from '@/lib/sidebar/workspaceGroups'
import { workspaceTitle } from '@/lib/workspaces/workspaceTitle'
import type { Workspace, WorkspacesGet, WorkspacesSet, WorkspacesState } from './workspaceTypes'

export function grouping(s: WorkspacesState): Grouping<Workspace> {
  return { workspaces: s.workspaces, groups: s.groups }
}

function applyGrouping(
  s: WorkspacesState,
  next: Grouping<Workspace>,
): Pick<WorkspacesState, 'workspaces' | 'groups'> {
  if (next.workspaces === s.workspaces && next.groups === s.groups) return s
  return { workspaces: next.workspaces, groups: next.groups }
}

type WorkspaceGroupActions = Pick<
  WorkspacesState,
  | 'setPinned'
  | 'moveBy'
  | 'drop'
  | 'createGroup'
  | 'moveToGroup'
  | 'moveToGroupNamed'
  | 'leaveGroup'
  | 'deleteGroup'
  | 'renameGroup'
  | 'setGroupColor'
  | 'setGroupCollapsed'
>

export function createWorkspaceGroupActions(
  set: WorkspacesSet,
  get: WorkspacesGet,
  { nextGroupId }: { nextGroupId: () => string },
): WorkspaceGroupActions {
  return {
    setPinned: (id, pinned) => set((s) => applyGrouping(s, pinWorkspace(grouping(s), id, pinned))),

    moveBy: (id, delta) => set((s) => applyGrouping(s, moveWorkspaceBy(grouping(s), id, delta))),

    drop: (source, target) => set((s) => applyGrouping(s, applyDrop(grouping(s), source, target))),

    createGroup: (workspaceId, name) => {
      const workspace = get().workspaces.find((w) => w.id === workspaceId)
      if (!workspace) return null
      const group = {
        id: nextGroupId(),
        name: normalizeGroupName(name ?? workspaceTitle(workspace)) ?? workspace.name,
      }
      set((s) => applyGrouping(s, createGroup(grouping(s), workspaceId, group)))
      return group.id
    },

    moveToGroup: (workspaceId, groupId) =>
      set((s) => applyGrouping(s, joinGroup(grouping(s), workspaceId, groupId))),

    moveToGroupNamed: (workspaceId, rawName) => {
      const name = normalizeGroupName(rawName)
      if (!name || !get().workspaces.some((w) => w.id === workspaceId)) return
      const existing = get().groups.find((group) => group.name === name)
      if (existing) get().moveToGroup(workspaceId, existing.id)
      else get().createGroup(workspaceId, name)
    },

    leaveGroup: (workspaceId) => set((s) => applyGrouping(s, leaveGroup(grouping(s), workspaceId))),

    deleteGroup: (groupId) => set((s) => applyGrouping(s, deleteGroup(grouping(s), groupId))),

    renameGroup: (groupId, rawName) => {
      const name = normalizeGroupName(rawName)
      if (name) set((s) => applyGrouping(s, patchGroup(grouping(s), groupId, { name })))
    },

    setGroupColor: (groupId, color) =>
      set((s) => applyGrouping(s, patchGroup(grouping(s), groupId, { color }))),

    setGroupCollapsed: (groupId, collapsed) =>
      set((s) => applyGrouping(s, patchGroup(grouping(s), groupId, { collapsed }))),
  }
}
