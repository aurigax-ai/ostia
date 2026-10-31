import type { WorkspaceLiveState } from '@shared/attention/attention'
import type { WorkspaceProject } from '@shared/files/filesApi'
import type {
  AppSnapshot,
  SnapshotWorkspace,
  WorkspaceOrigin,
} from '@shared/workspaces/workspaceApi'
import type { WorkspaceGroupColor } from '@shared/workspaces/workspaceGroups'
import type { StoreApi } from 'zustand'
import type { DragSource, DropTarget, WorkspaceGroup } from '@/lib/sidebar/workspaceGroups'
import type { NewWorkspacePlacement } from '@/stores/app/settingsModel'

export type WorkspaceState = WorkspaceLiveState

export type WorkspaceKind = 'terminal' | 'scratch' | 'manager'

export interface Workspace {
  id: string
  name: string
  customName?: string
  description?: string
  pinned?: boolean
  groupId?: string
  kind: WorkspaceKind
  workDir: string
  state: WorkspaceState
  projectDir?: string
  anchored?: true
  origin?: WorkspaceOrigin
}

export interface WorkspacesState {
  workspaces: Workspace[]
  groups: WorkspaceGroup[]
  activeWorkspaceId: string | null
  setActive: (id: string) => void
  addWorkspace: (
    workDir?: string,
    placement?: NewWorkspacePlacement,
    kind?: WorkspaceKind,
    groupId?: string,
    ungrouped?: boolean,
  ) => void
  closeWorkspace: (id: string) => void
  setWorkDir: (id: string, workDir: string) => void
  rename: (id: string, name: string) => void
  setProject: (id: string, project: WorkspaceProject, anchor?: boolean) => void
  describe: (id: string, text: string) => void
  setPinned: (id: string, pinned: boolean) => void
  moveBy: (id: string, delta: number) => void
  drop: (source: DragSource, target: DropTarget) => void
  createGroup: (workspaceId: string, name?: string) => string | null
  moveToGroup: (workspaceId: string, groupId: string) => void
  moveToGroupNamed: (workspaceId: string, name: string) => void
  leaveGroup: (workspaceId: string) => void
  deleteGroup: (groupId: string) => void
  renameGroup: (groupId: string, name: string) => void
  setGroupColor: (groupId: string, color: WorkspaceGroupColor | null) => void
  setGroupCollapsed: (groupId: string, collapsed: boolean) => void
  closeOthers: (id: string) => void
  setState: (id: string, state: WorkspaceState) => void
  hydrate: (snapshot: AppSnapshot | null) => void
  release: (id: string) => void
  merge: (sourceId: string, targetId: string) => void
  adopt: (workspaces: SnapshotWorkspace[]) => void
}

export type WorkspacesSet = StoreApi<WorkspacesState>['setState']
export type WorkspacesGet = StoreApi<WorkspacesState>['getState']
