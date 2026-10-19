import { restoreSnapshot } from '@/lib/layout/snapshot'
import { normalizeGroups } from '@/lib/sidebar/workspaceGroups'
import { useLayoutStore } from './layoutStore'
import type { Workspace, WorkspacesGet, WorkspacesSet, WorkspacesState } from './workspaceTypes'

type WorkspaceTransferActions = Pick<WorkspacesState, 'release' | 'merge' | 'adopt'>

export function createWorkspaceTransferActions(
  set: WorkspacesSet,
  get: WorkspacesGet,
  { adoptWorkspaceIds }: { adoptWorkspaceIds: (ids: string[]) => void },
): WorkspaceTransferActions {
  return {
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

    merge: (sourceId, targetId) => {
      const ids = get().workspaces.map((w) => w.id)
      if (sourceId === targetId || !ids.includes(sourceId) || !ids.includes(targetId)) return
      useLayoutStore.getState().merge(sourceId, targetId)
      set((s) => {
        const remaining = s.workspaces.filter((w) => w.id !== sourceId)
        const next = normalizeGroups({ workspaces: remaining, groups: s.groups })
        return { workspaces: next.workspaces, groups: next.groups, activeWorkspaceId: targetId }
      })
      window.ostia.lifecycle.emit({ type: 'workspace-activated', workspaceId: targetId })
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
      const adopted = workspaces.map(({ origin, ...w }) => {
        const workspace: Workspace = {
          ...w,
          ...(origin?.groupId ? { groupId: origin.groupId } : {}),
          state: 'idle',
        }
        return { workspace, index: origin?.index }
      })
      set((s) => {
        const list = [...s.workspaces]
        for (const { workspace, index } of adopted) {
          list.splice(Math.min(index ?? list.length, list.length), 0, workspace)
        }
        const next = normalizeGroups({ workspaces: list, groups: s.groups })
        return {
          workspaces: next.workspaces,
          groups: next.groups,
          activeWorkspaceId: adopted[adopted.length - 1].workspace.id,
        }
      })
      useLayoutStore.getState().adopt(layouts)
      for (const { workspace } of adopted) {
        window.ostia.lifecycle.emit({
          type: 'workspace-added',
          workspaceId: workspace.id,
          workDir: workspace.workDir,
        })
      }
      window.ostia.lifecycle.emit({
        type: 'workspace-activated',
        workspaceId: adopted[adopted.length - 1].workspace.id,
      })
    },
  }
}
