import { normalizeSplitTabName, SPLIT_TAB_NAME_MAX } from '@shared/workspaces/splitTabs'
import { changeCollapse, foldSplitTab, isTucked } from '@/lib/layout/collapse'
import { joinSplitTab, separateFromSplitTab } from '@/lib/layout/tabJoin'
import { movePane, moveTab } from '@/lib/layout/tabMoves'
import {
  findSplitTab,
  findSplitTabByName,
  focusIdOf,
  setSplitTabName,
  tabsOfPane,
} from '@/lib/layout/tree'
import type { LayoutNode } from '@/lib/layout/types'
import { forgetAgentSplitTab } from '@/lib/panes/agentSplitTabs'
import { patch } from '@/lib/panes/layoutPatch'
import {
  forgetDragged,
  markNewSplitTab,
  splitTabPartner,
  tabColumns,
  tabMembership,
} from '@/lib/panes/splitTabPlacement'
import { forgetSplitTabSeeds, seedSplitTab } from '@/lib/panes/splitTabSeeds'
import { keepKeyboard } from './keepKeyboard'
import type { LayoutGet, LayoutSet, LayoutState, WorkspaceLayout } from './layoutTypes'
import { surfaceHoldsKeyboard } from './surfaceSlotsStore'

type LayoutTabActions = Pick<
  LayoutState,
  'movePane' | 'moveTab' | 'renameSplitTab' | 'joinTab' | 'changeCollapse' | 'foldSplitTab'
>

function tuckedAway(layout: WorkspaceLayout, root: LayoutNode): WorkspaceLayout {
  if (root === layout.root) return layout
  const away = (id: string | null) => id !== null && isTucked(root, id)
  return {
    ...layout,
    root,
    activePaneId: away(layout.activePaneId)
      ? (tabsOfPane(root, layout.activePaneId)?.activeId ?? layout.activePaneId)
      : layout.activePaneId,
    zoomedPaneId: away(layout.zoomedPaneId) ? null : layout.zoomedPaneId,
  }
}

export function createLayoutTabActions(set: LayoutSet, get: LayoutGet): LayoutTabActions {
  return {
    movePane: (workspaceId, sourceId, targetId, zone) => {
      forgetDragged(get().byWorkspace[workspaceId]?.root, sourceId)
      set(
        (s) =>
          patch(s, workspaceId, (l) => {
            const root = movePane(l.root, sourceId, targetId, zone)
            return { ...l, root, activePaneId: focusIdOf(root, sourceId) ?? l.activePaneId }
          }) ?? s,
      )
    },

    moveTab: (workspaceId, sourceId, targetId, after) => {
      forgetDragged(get().byWorkspace[workspaceId]?.root, sourceId)
      set(
        (s) =>
          patch(s, workspaceId, (l) => {
            const root = moveTab(l.root, sourceId, targetId, after)
            return { ...l, root, activePaneId: focusIdOf(root, sourceId) ?? l.activePaneId }
          }) ?? s,
      )
    },

    renameSplitTab: (workspaceId, tabId, name) => {
      const trimmed = name.trim()
      const next = trimmed ? normalizeSplitTabName(trimmed.slice(0, SPLIT_TAB_NAME_MAX)) : null
      if (trimmed && !next) return
      const root = get().byWorkspace[workspaceId]?.root
      const current = root ? findSplitTab(root, tabId) : null
      if (current && (current.name ?? null) !== next) forgetAgentSplitTab(tabId)
      set(
        (s) =>
          patch(s, workspaceId, (l) => ({ ...l, root: setSplitTabName(l.root, tabId, next) })) ?? s,
      )
    },

    changeCollapse: (workspaceId, paneId, change) => {
      const active = get().byWorkspace[workspaceId]?.activePaneId
      const heldKeyboard = active !== undefined && surfaceHoldsKeyboard(active)
      set(
        (s) =>
          patch(s, workspaceId, (l) => tuckedAway(l, changeCollapse(l.root, paneId, change))) ?? s,
      )
      if (heldKeyboard) keepKeyboard(get, workspaceId)
    },

    foldSplitTab: (workspaceId, tabId) =>
      set((s) => patch(s, workspaceId, (l) => tuckedAway(l, foldSplitTab(l.root, tabId))) ?? s),

    joinTab: (workspaceId, ids, tab) => {
      const layout = get().byWorkspace[workspaceId]
      if (!layout) return []
      const before = layout.root
      const partner = tab === null ? undefined : splitTabPartner(workspaceId, before, tab)
      const root =
        tab === null
          ? separateFromSplitTab(before, ids, tabColumns())
          : joinSplitTab(before, ids, tab, tabColumns(), partner)
      forgetSplitTabSeeds(ids)
      if (tab !== null) markNewSplitTab(before, root, tab)
      const lone = tab !== null && root === before && ids.length === 1 && !partner
      if (lone && !findSplitTabByName(before, tab)) seedSplitTab(workspaceId, tab, ids[0])
      if (tab !== null && findSplitTabByName(root, tab) && partner) forgetSplitTabSeeds([partner])
      if (root !== before) {
        set((s) => patch(s, workspaceId, (l) => ({ ...l, root, zoomedPaneId: null })) ?? s)
      }
      return ids.filter(
        (id) =>
          (lone && !findSplitTabByName(before, tab)) ||
          tabMembership(before, id) !== tabMembership(root, id),
      )
    },
  }
}
