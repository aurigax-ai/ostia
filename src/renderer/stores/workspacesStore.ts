import type {
  AppSnapshot,
  SnapshotWorkspace,
  WorkspaceLiveState,
  WorkspaceProject,
} from '@shared/types'
import { type WorkspaceGroupColor, normalizeGroupName } from '@shared/workspaceGroups'
import { normalizeDescription } from '@shared/workspaceText'
import { create } from 'zustand'
import { restoreSnapshot } from '../layout/snapshot'
import { namespacedId } from '../lib/idNamespace'
import {
  type DragSource,
  type DropTarget,
  type Grouping,
  type WorkspaceGroup,
  applyDrop,
  createGroup,
  deleteGroup,
  insertWorkspace,
  joinGroup,
  leaveGroup,
  matchGroupRule,
  moveWorkspaceBy,
  normalizeGroups,
  patchGroup,
  pinWorkspace,
} from '../lib/workspaceGroups'
import { insertIndex } from '../lib/workspaceOrder'
import { useLayoutStore } from './layoutStore'
import { type NewWorkspacePlacement, useSettingsStore } from './settingsStore'

export type { WorkspaceGroup }

export type WorkspaceState = WorkspaceLiveState

export type WorkspaceKind = 'agent' | 'terminal' | 'scratch' | 'manager'

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
}

interface WorkspacesState {
  workspaces: Workspace[]
  groups: WorkspaceGroup[]
  activeWorkspaceId: string | null
  setActive: (id: string) => void
  addWorkspace: (workDir?: string, placement?: NewWorkspacePlacement, kind?: WorkspaceKind) => void
  closeWorkspace: (id: string) => void
  setWorkDir: (id: string, workDir: string) => void
  rename: (id: string, name: string) => void
  setProject: (id: string, project: WorkspaceProject) => void
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
  adopt: (workspaces: SnapshotWorkspace[]) => void
}

let seq = 0
export function nextWorkspaceId(): string {
  seq += 1
  return namespacedId('w', seq, '')
}

let groupSeq = 0
function nextGroupId(): string {
  groupSeq += 1
  return namespacedId('g', groupSeq, '')
}

function highestId(ids: string[], prefix: 'w' | 'g', floor: number): number {
  let max = floor
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue
    const n = Number(id.slice(1))
    if (Number.isInteger(n) && n > 0) max = Math.max(max, n)
  }
  return max
}

function adoptWorkspaceIds(ids: string[]): void {
  seq = highestId(ids, 'w', seq)
}

function adoptGroupIds(ids: string[]): void {
  groupSeq = highestId(ids, 'g', groupSeq)
}

export function resetWorkspaceIds(): void {
  seq = 0
  groupSeq = 0
}

function nameFromWorkDir(workDir: string): string {
  if (!workDir || workDir === '~') return 'home'
  const trimmed = workDir.replace(/\/+$/, '')
  const last = trimmed.split('/').pop()
  return last || 'workspace'
}

function makeWorkspace(workDir: string, kind: WorkspaceKind = 'terminal'): Workspace {
  return { id: nextWorkspaceId(), name: nameFromWorkDir(workDir), kind, workDir, state: 'idle' }
}

function grouping(s: WorkspacesState): Grouping<Workspace> {
  return { workspaces: s.workspaces, groups: s.groups }
}

function applyGrouping(
  s: WorkspacesState,
  next: Grouping<Workspace>,
): Pick<WorkspacesState, 'workspaces' | 'groups'> {
  if (next.workspaces === s.workspaces && next.groups === s.groups) return s
  return { workspaces: next.workspaces, groups: next.groups }
}

function withNamedGroup(
  g: Grouping<Workspace>,
  name: string,
): { grouping: Grouping<Workspace>; groupId: string } {
  const existing = g.groups.find((group) => group.name === name)
  if (existing) return { grouping: g, groupId: existing.id }
  const group = { id: nextGroupId(), name }
  return { grouping: { ...g, groups: [...g.groups, group] }, groupId: group.id }
}

function placeNewWorkspace(
  s: WorkspacesState,
  created: Workspace,
  placement: NewWorkspacePlacement,
): Grouping<Workspace> {
  const ruleGroup = normalizeGroupName(
    matchGroupRule(useSettingsStore.getState().workspaceGroups.byCwd, created.workDir),
  )
  if (ruleGroup) {
    const named = withNamedGroup(grouping(s), ruleGroup)
    return insertWorkspace(named.grouping, { ...created, groupId: named.groupId })
  }
  const active = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
  if (active?.groupId) {
    return insertWorkspace(grouping(s), { ...created, groupId: active.groupId }, active.id)
  }
  const at = insertIndex(s.workspaces, placement, s.activeWorkspaceId)
  return normalizeGroups({
    workspaces: [...s.workspaces.slice(0, at), created, ...s.workspaces.slice(at)],
    groups: s.groups,
  })
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  workspaces: [],
  groups: [],
  activeWorkspaceId: null,
  setActive: (id) => {
    set({ activeWorkspaceId: id })
    window.pine?.lifecycle?.emit?.({ type: 'workspace-activated', workspaceId: id })
  },

  addWorkspace: (workDir = '~', placement = 'end', kind = 'terminal') => {
    const workspace = makeWorkspace(workDir, kind)
    set((s) => {
      const next = placeNewWorkspace(s, workspace, placement)
      return { workspaces: next.workspaces, groups: next.groups, activeWorkspaceId: workspace.id }
    })
    window.pine?.lifecycle?.emit?.({ type: 'workspace-added', workspaceId: workspace.id, workDir })
  },

  closeWorkspace: (id) => {
    useLayoutStore.getState().removeWorkspace(id)
    window.pine?.lifecycle?.emit?.({ type: 'workspace-closed', workspaceId: id })

    set((s) => {
      const remaining = s.workspaces.filter((c) => c.id !== id)
      const idx = s.workspaces.findIndex((c) => c.id === id)
      let activeWorkspaceId = s.activeWorkspaceId
      if (id === s.activeWorkspaceId) {
        activeWorkspaceId = remaining[Math.max(0, idx - 1)]?.id ?? remaining[0]?.id ?? null
      }
      const next = normalizeGroups({ workspaces: remaining, groups: s.groups })
      return { workspaces: next.workspaces, groups: next.groups, activeWorkspaceId }
    })
  },

  setWorkDir: (id, workDir) => {
    set((s) => ({
      workspaces: s.workspaces.map((c) =>
        c.id === id ? { ...c, workDir, name: nameFromWorkDir(workDir) } : c,
      ),
    }))
    window.pine?.lifecycle?.emit?.({ type: 'workspace-added', workspaceId: id, workDir })
  },

  setProject: (id, project) =>
    set((s) => {
      const current = s.workspaces.find((w) => w.id === id)
      if (
        !current ||
        (current.name === project.name &&
          current.projectDir === project.display &&
          current.workDir === project.dir)
      ) {
        return s
      }
      return {
        workspaces: s.workspaces.map((w) =>
          w.id === id
            ? { ...w, name: project.name, projectDir: project.display, workDir: project.dir }
            : w,
        ),
      }
    }),

  rename: (id, name) => {
    const customName = name.trim()
    set((s) => ({
      workspaces: s.workspaces.map((c) => {
        if (c.id !== id) return c
        const { customName: _old, ...rest } = c
        return customName ? { ...rest, customName } : rest
      }),
    }))
  },

  describe: (id, text) => {
    const description = normalizeDescription(text)
    set((s) => ({
      workspaces: s.workspaces.map((c) => {
        if (c.id !== id || c.description === description) return c
        const { description: _old, ...rest } = c
        return description ? { ...rest, description } : rest
      }),
    }))
  },

  setPinned: (id, pinned) => set((s) => applyGrouping(s, pinWorkspace(grouping(s), id, pinned))),

  moveBy: (id, delta) => set((s) => applyGrouping(s, moveWorkspaceBy(grouping(s), id, delta))),

  drop: (source, target) => set((s) => applyGrouping(s, applyDrop(grouping(s), source, target))),

  createGroup: (workspaceId, name) => {
    const workspace = get().workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return null
    const group = {
      id: nextGroupId(),
      name: normalizeGroupName(name ?? workspace.customName ?? workspace.name) ?? workspace.name,
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

  closeOthers: (id) => {
    for (const other of get().workspaces) if (other.id !== id) get().closeWorkspace(other.id)
    get().setActive(id)
  },

  hydrate: (snapshot) => {
    if (snapshot) {
      const { workspaces, groups, activeWorkspaceId, layouts } = restoreSnapshot(snapshot)
      adoptWorkspaceIds(workspaces.map((s) => s.id))
      adoptGroupIds(groups.map((g) => g.id))
      const next = normalizeGroups({
        workspaces: workspaces.map((s): Workspace => ({ ...s, state: 'idle' })),
        groups,
      })
      set({ workspaces: next.workspaces, groups: next.groups, activeWorkspaceId })
      useLayoutStore.getState().hydrate(layouts)
    }

    for (const s of get().workspaces) {
      window.pine?.lifecycle?.emit?.({
        type: 'workspace-added',
        workspaceId: s.id,
        workDir: s.workDir,
      })
    }
    const activeWorkspaceId = get().activeWorkspaceId
    if (activeWorkspaceId) {
      window.pine?.lifecycle?.emit?.({
        type: 'workspace-activated',
        workspaceId: activeWorkspaceId,
      })
    }
  },

  setState: (id, state) => {
    const current = get().workspaces.find((c) => c.id === id)
    if (!current || current.state === state) return
    set((s) => ({
      workspaces: s.workspaces.map((c) => (c.id === id ? { ...c, state } : c)),
    }))
    window.pine?.lifecycle?.emit?.({ type: 'workspace-state', workspaceId: id, state })
  },

  release: (id) => {
    if (!get().workspaces.some((w) => w.id === id)) return
    useLayoutStore.getState().release(id)
    set((s) => {
      const idx = s.workspaces.findIndex((c) => c.id === id)
      const remaining = s.workspaces.filter((c) => c.id !== id)
      const activeWorkspaceId =
        s.activeWorkspaceId === id
          ? (remaining[Math.max(0, idx - 1)]?.id ?? remaining[0]?.id ?? null)
          : s.activeWorkspaceId
      const next = normalizeGroups({ workspaces: remaining, groups: s.groups })
      return { workspaces: next.workspaces, groups: next.groups, activeWorkspaceId }
    })
  },

  adopt: (incoming) => {
    const known = new Set(get().workspaces.map((w) => w.id))
    const fresh = incoming.filter((w) => !known.has(w.id))
    if (fresh.length === 0) return
    const { workspaces, layouts } = restoreSnapshot({
      v: 1,
      savedAt: '',
      activeWorkspaceId: null,
      workspaces: fresh,
      groups: [],
    })
    adoptWorkspaceIds(workspaces.map((w) => w.id))
    const adopted = workspaces.map((w): Workspace => ({ ...w, state: 'idle' }))
    set((s) => {
      const next = normalizeGroups({ workspaces: [...s.workspaces, ...adopted], groups: s.groups })
      return {
        workspaces: next.workspaces,
        groups: next.groups,
        activeWorkspaceId: adopted[adopted.length - 1].id,
      }
    })
    useLayoutStore.getState().adopt(layouts)
    for (const w of adopted) {
      window.pine?.lifecycle?.emit?.({
        type: 'workspace-added',
        workspaceId: w.id,
        workDir: w.workDir,
      })
    }
    window.pine?.lifecycle?.emit?.({
      type: 'workspace-activated',
      workspaceId: adopted[adopted.length - 1].id,
    })
  },
}))
