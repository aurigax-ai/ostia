import type { AppSnapshot, WorkspaceLiveState } from '@shared/types'
import { normalizeDescription } from '@shared/workspaceText'
import { create } from 'zustand'
import { restoreSnapshot } from '../layout/snapshot'
import { insertIndex, moveBy, moveTo, setPinned } from '../lib/workspaceOrder'
import { useLayoutStore } from './layoutStore'
import type { NewWorkspacePlacement } from './settingsStore'

export type WorkspaceState = WorkspaceLiveState

export type WorkspaceKind = 'agent' | 'terminal' | 'scratch'

export interface Workspace {
  id: string
  name: string
  customName?: string
  description?: string
  pinned?: boolean
  kind: WorkspaceKind
  workDir: string
  state: WorkspaceState
}

interface WorkspacesState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  setActive: (id: string) => void
  addWorkspace: (workDir?: string, placement?: NewWorkspacePlacement) => void
  closeWorkspace: (id: string) => void
  setWorkDir: (id: string, workDir: string) => void
  rename: (id: string, name: string) => void
  describe: (id: string, text: string) => void
  setPinned: (id: string, pinned: boolean) => void
  moveBy: (id: string, delta: number) => void
  moveTo: (id: string, index: number) => void
  closeOthers: (id: string) => void
  setState: (id: string, state: WorkspaceState) => void
  hydrate: (snapshot: AppSnapshot | null) => void
}

let seq = 0
function nextId(): string {
  seq += 1
  return `w${seq}`
}

function adoptWorkspaceIds(ids: string[]): void {
  for (const id of ids) {
    const n = Number(/^w(\d+)$/.exec(id)?.[1])
    if (Number.isFinite(n)) seq = Math.max(seq, n)
  }
}

function nameFromWorkDir(workDir: string): string {
  if (!workDir || workDir === '~') return 'home'
  const trimmed = workDir.replace(/\/+$/, '')
  const last = trimmed.split('/').pop()
  return last || 'workspace'
}

function makeWorkspace(workDir: string, kind: WorkspaceKind = 'terminal'): Workspace {
  return { id: nextId(), name: nameFromWorkDir(workDir), kind, workDir, state: 'idle' }
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  setActive: (id) => {
    set({ activeWorkspaceId: id })
    window.pine?.lifecycle?.emit?.({ type: 'workspace-activated', workspaceId: id })
  },

  addWorkspace: (workDir = '~', placement = 'end') => {
    const workspace = makeWorkspace(workDir)
    set((s) => {
      const at = insertIndex(s.workspaces, placement, s.activeWorkspaceId)
      return {
        workspaces: [...s.workspaces.slice(0, at), workspace, ...s.workspaces.slice(at)],
        activeWorkspaceId: workspace.id,
      }
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
      return { workspaces: remaining, activeWorkspaceId }
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

  setPinned: (id, pinned) => set((s) => ({ workspaces: setPinned(s.workspaces, id, pinned) })),

  moveBy: (id, delta) => set((s) => ({ workspaces: moveBy(s.workspaces, id, delta) })),

  moveTo: (id, index) => set((s) => ({ workspaces: moveTo(s.workspaces, id, index) })),

  closeOthers: (id) => {
    for (const other of get().workspaces) if (other.id !== id) get().closeWorkspace(other.id)
    get().setActive(id)
  },

  hydrate: (snapshot) => {
    if (snapshot) {
      const { workspaces, activeWorkspaceId, layouts } = restoreSnapshot(snapshot)
      adoptWorkspaceIds(workspaces.map((s) => s.id))
      set({ workspaces: workspaces.map((s) => ({ ...s, state: 'idle' })), activeWorkspaceId })
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
}))
