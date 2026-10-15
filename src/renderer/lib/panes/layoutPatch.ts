import { equalizeSizes } from '@/lib/layout/panelSize'
import { closePane, firstPaneId, selectTab, slotCount, tabsOfPane } from '@/lib/layout/tree'
import type { LayoutNode } from '@/lib/layout/types'
import { useSettingsStore } from '@/stores/app/settingsStore'
import type { LayoutState, WorkspaceLayout } from '@/stores/workspaces/layoutTypes'

export function layoutOf(root: LayoutNode): WorkspaceLayout {
  return { root, activePaneId: firstPaneId(root), zoomedPaneId: null }
}

export function patch(
  state: LayoutState,
  workspaceId: string,
  fn: (layout: WorkspaceLayout) => WorkspaceLayout,
): Pick<LayoutState, 'byWorkspace'> | null {
  const layout = state.byWorkspace[workspaceId]
  if (!layout) return null
  const next = fn(layout)
  const selected = selectTab(next.root, next.activePaneId)
  const created = slotCount(selected) > slotCount(layout.root)
  const equalize = created && useSettingsStore.getState().panes.equalizeOnSplit
  const root = equalize ? equalizeSizes(selected) : selected
  const equalized = equalize ? (next.equalized ?? layout.equalized ?? 0) + 1 : undefined
  const carried = equalized ?? next.equalized ?? layout.equalized
  const result: WorkspaceLayout = { ...next, root }
  if (carried !== undefined) result.equalized = carried
  return {
    byWorkspace: {
      ...state.byWorkspace,
      [workspaceId]: root === next.root && carried === next.equalized ? next : result,
    },
  }
}

export function successorOf(before: LayoutNode, after: LayoutNode, closedId: string): string {
  const tabs = tabsOfPane(before, closedId)
  const survivor = tabs ? closePane(tabs, closedId) : null
  return survivor && survivor !== tabs ? firstPaneId(survivor) : firstPaneId(after)
}
