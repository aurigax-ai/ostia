import { graftNode, landTab, takeTab } from '@/lib/layout/tabMoves'
import {
  closePane,
  findPane,
  firstPaneId,
  focusIdOf,
  mergeLayouts,
  paneIds,
} from '@/lib/layout/tree'
import { patch, successorOf } from '@/lib/panes/layoutPatch'
import type { LayoutGet, LayoutSet, LayoutState, WorkspaceLayout } from './layoutTypes'

type LayoutTransferActions = Pick<
  LayoutState,
  'removeWorkspace' | 'release' | 'releasePane' | 'graft' | 'merge' | 'moveTabTo' | 'adopt'
>

export function createLayoutTransferActions(set: LayoutSet, get: LayoutGet): LayoutTransferActions {
  return {
    removeWorkspace: (workspaceId) => {
      const layout = get().byWorkspace[workspaceId]
      set((s) => {
        if (!(workspaceId in s.byWorkspace)) return s
        const { [workspaceId]: _removed, ...byWorkspace } = s.byWorkspace
        return { byWorkspace }
      })
      if (layout) {
        for (const paneId of paneIds(layout.root)) {
          window.ostia?.lifecycle?.emit?.({ type: 'pane-closed', workspaceId, paneId })
        }
      }
    },

    release: (workspaceId) =>
      set((s) => {
        if (!(workspaceId in s.byWorkspace)) return s
        const { [workspaceId]: _released, ...byWorkspace } = s.byWorkspace
        return { byWorkspace }
      }),

    releasePane: (workspaceId, paneId) => {
      const current = get().byWorkspace[workspaceId]
      if (!current || !findPane(current.root, paneId)) return
      if (current.root.type === 'pane') {
        get().release(workspaceId)
        return
      }
      set(
        (s) =>
          patch(s, workspaceId, (l) => {
            const root = closePane(l.root, paneId)
            const activePaneId =
              paneId === l.activePaneId ? successorOf(l.root, root, paneId) : l.activePaneId
            return {
              root,
              activePaneId,
              zoomedPaneId: l.zoomedPaneId === paneId ? null : l.zoomedPaneId,
            }
          }) ?? s,
      )
    },

    graft: (workspaceId, incoming, beside) => {
      set((s) => {
        if (!s.byWorkspace[workspaceId]) {
          return { byWorkspace: { ...s.byWorkspace, [workspaceId]: { ...incoming } } }
        }
        return (
          patch(s, workspaceId, (l) => ({
            ...l,
            root: graftNode(l.root, incoming.root, beside),
            activePaneId: incoming.activePaneId,
            zoomedPaneId: null,
          })) ?? s
        )
      })
      for (const paneId of paneIds(incoming.root)) {
        window.ostia?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId })
      }
    },
    merge: (sourceId, targetId) =>
      set((s) => {
        const source = s.byWorkspace[sourceId]
        if (sourceId === targetId || !source) return s
        const { [sourceId]: _moved, ...byWorkspace } = s.byWorkspace
        if (!byWorkspace[targetId]) return { byWorkspace: { ...byWorkspace, [targetId]: source } }
        return (
          patch({ ...s, byWorkspace }, targetId, (l) => ({
            ...l,
            root: mergeLayouts(l.root, source.root),
            activePaneId: source.activePaneId,
            zoomedPaneId: null,
          })) ?? s
        )
      }),

    moveTabTo: (sourceId, targetId, tabId) => {
      const source = get().byWorkspace[sourceId]
      const taken = source && sourceId !== targetId ? takeTab(source.root, tabId) : null
      if (!source || !taken) return []
      const moved = paneIds(taken.tab)
      const shown = focusIdOf(source.root, tabId) ?? firstPaneId(taken.tab)
      set((s) => {
        const target = s.byWorkspace[targetId]
        const landed: WorkspaceLayout = {
          ...target,
          root: landTab(target?.root ?? null, taken.tab, target?.activePaneId ?? shown),
          activePaneId: shown,
          zoomedPaneId: null,
        }
        const seeded = { ...s, byWorkspace: { ...s.byWorkspace, [targetId]: target ?? landed } }
        const next = { ...seeded, ...patch(seeded, targetId, () => landed) }
        const rest = taken.rest
        if (!rest) {
          const { [sourceId]: _moved, ...byWorkspace } = next.byWorkspace
          return { byWorkspace }
        }
        return (
          patch(next, sourceId, (l) => ({
            ...l,
            root: rest,
            activePaneId: moved.includes(l.activePaneId)
              ? (taken.successor ?? firstPaneId(rest))
              : l.activePaneId,
            zoomedPaneId: l.zoomedPaneId && moved.includes(l.zoomedPaneId) ? null : l.zoomedPaneId,
          })) ?? next
        )
      })
      return moved
    },

    adopt: (layouts) => {
      set((s) => ({ byWorkspace: { ...s.byWorkspace, ...layouts } }))
      for (const [workspaceId, layout] of Object.entries(layouts)) {
        for (const paneId of paneIds(layout.root)) {
          window.ostia?.lifecycle?.emit?.({ type: 'pane-created', workspaceId, paneId })
        }
      }
    },
  }
}
