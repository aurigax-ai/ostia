import { normalizeGroupName } from '@shared/workspaces/workspaceGroups'
import { normalizeDescription } from '@shared/workspaces/workspaceText'
import { create } from 'zustand'
import { restoreSnapshot } from '@/lib/layout/snapshot'
import {
  type Grouping,
  insertWorkspace,
  matchGroupRule,
  normalizeGroups,
  patchGroup,
} from '@/lib/sidebar/workspaceGroups'
import { namespacedId } from '@/lib/workspaces/idNamespace'
import { insertIndex } from '@/lib/workspaces/workspaceOrder'
import type { NewWorkspacePlacement } from '@/stores/app/settingsModel'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from './layoutStore'
import { createWorkspaceGroupActions, grouping } from './workspaceGroupActions'
import { setWorkspaceLookup } from './workspaceLookup'
import { createWorkspaceTransferActions } from './workspaceTransferActions'
import type { Workspace, WorkspaceKind, WorkspacesState } from './workspaceTypes'

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

export function nameFromWorkDir(workDir: string): string {
  if (!workDir || workDir === '~') return 'home'
  const trimmed = workDir.replace(/\/+$/, '')
  const last = trimmed.split('/').pop()
  return last || 'workspace'
}

function makeWorkspace(workDir: string, kind: WorkspaceKind = 'terminal'): Workspace {
  return { id: nextWorkspaceId(), name: nameFromWorkDir(workDir), kind, workDir, state: 'idle' }
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
  groupId?: string,
  ungrouped = false,
): Grouping<Workspace> {
  const ruleGroup = ungrouped
    ? ''
    : normalizeGroupName(
        matchGroupRule(useSettingsStore.getState().workspaceGroups.byCwd, created.workDir),
      )
  if (ruleGroup) {
    const named = withNamedGroup(grouping(s), ruleGroup)
    return insertWorkspace(named.grouping, { ...created, groupId: named.groupId })
  }
  if (!ungrouped && groupId && s.groups.some((group) => group.id === groupId)) {
    const expanded = patchGroup(grouping(s), groupId, { collapsed: false })
    return insertWorkspace(expanded, { ...created, groupId })
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
    window.ostia.lifecycle.emit({ type: 'workspace-activated', workspaceId: id })
  },

  addWorkspace: (
    workDir = '~',
    placement = 'end',
    kind = 'terminal',
    groupId?: string,
    ungrouped?: boolean,
  ) => {
    const workspace = makeWorkspace(workDir, kind)
    set((s) => {
      const next = placeNewWorkspace(s, workspace, placement, groupId, ungrouped)
      return { workspaces: next.workspaces, groups: next.groups, activeWorkspaceId: workspace.id }
    })
    window.ostia.lifecycle.emit({ type: 'workspace-added', workspaceId: workspace.id, workDir })
  },

  closeWorkspace: (id) => {
    if (useLayoutStore.getState().isLocked(id)) return
    useLayoutStore.getState().removeWorkspace(id)
    window.ostia.lifecycle.emit({ type: 'workspace-closed', workspaceId: id })

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
    window.ostia.lifecycle.emit({ type: 'workspace-added', workspaceId: id, workDir })
  },

  setProject: (id, project, anchor = false) => {
    const current = get().workspaces.find((w) => w.id === id)
    const anchored = anchor || project.repo || current?.anchored === true
    if (
      !current ||
      (current.name === project.name &&
        current.projectDir === project.display &&
        current.workDir === project.dir &&
        (current.anchored === true) === anchored)
    ) {
      return
    }
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id
          ? {
              ...w,
              name: project.name,
              projectDir: project.display,
              workDir: project.dir,
              ...(anchored ? { anchored: true as const } : {}),
            }
          : w,
      ),
    }))
    if (current.workDir !== project.dir) {
      window.ostia.lifecycle.emit({
        type: 'workspace-added',
        workspaceId: id,
        workDir: project.dir,
      })
    }
  },

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
      window.ostia.lifecycle.emit({
        type: 'workspace-added',
        workspaceId: s.id,
        workDir: s.workDir,
      })
    }
    const activeWorkspaceId = get().activeWorkspaceId
    if (activeWorkspaceId) {
      window.ostia.lifecycle.emit({
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
    window.ostia.lifecycle.emit({ type: 'workspace-state', workspaceId: id, state })
  },

  ...createWorkspaceGroupActions(set, get, { nextGroupId }),
  ...createWorkspaceTransferActions(set, get, { adoptWorkspaceIds }),
}))

setWorkspaceLookup((workspaceId) =>
  useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId),
)
