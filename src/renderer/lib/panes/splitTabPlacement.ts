import type { SplitTabPlacement } from '@shared/workspaces/splitTabs'
import { joinSplitTab } from '@/lib/layout/tabJoin'
import {
  addTab,
  allPanes,
  findPane,
  findSplitTab,
  findSplitTabByName,
  paneIds,
  splitTabOfPane,
  tabIdOf,
} from '@/lib/layout/tree'
import type { LayoutNode, PaneNode } from '@/lib/layout/types'
import { isAgentSplitTab, markAgentSplitTab } from './agentSplitTabs'
import { forgetSplitTabSeeds, splitTabSeed } from './splitTabSeeds'
import { readableColumns } from './splitTabs'

export function splitTabPartner(
  workspaceId: string,
  root: LayoutNode,
  name: string,
): string | undefined {
  const seed = splitTabSeed(workspaceId, name)
  return seed && findPane(root, seed) && !splitTabOfPane(root, seed) ? seed : undefined
}

export function markNewSplitTab(before: LayoutNode, after: LayoutNode, name: string): void {
  const made = findSplitTabByName(after, name)
  if (made && !findSplitTab(before, made.id)) markAgentSplitTab(made.id)
}

export function splitTabAnchor(
  workspaceId: string,
  root: LayoutNode,
  splitTab: SplitTabPlacement,
): string | null {
  const named = findSplitTabByName(root, splitTab.name)
  if (named && !isAgentSplitTab(named.id)) return null
  if (named) {
    const panes = allPanes(named)
    return panes[panes.length - 1].id
  }
  return splitTabPartner(workspaceId, root, splitTab.name) ?? null
}

export function joinedTerminal(
  root: LayoutNode,
  anchor: string,
  pane: PaneNode,
  splitTab: SplitTabPlacement,
): LayoutNode {
  const withPane = addTab(root, anchor, pane, true)
  const partner = findSplitTabByName(root, splitTab.name) ? undefined : anchor
  return joinSplitTab(withPane, [pane.id], splitTab.name, tabColumns(), partner)
}

export function tabColumns(): number {
  return readableColumns(window.innerWidth)
}

export function tabMembership(root: LayoutNode, paneId: string): string {
  return `${tabIdOf(root, paneId)}:${splitTabOfPane(root, paneId)?.name ?? ''}`
}

export function forgetDragged(root: LayoutNode | undefined, sourceId: string): void {
  const source = root ? (findPane(root, sourceId) ?? findSplitTab(root, sourceId)) : null
  if (source) forgetSplitTabSeeds(paneIds(source))
}
