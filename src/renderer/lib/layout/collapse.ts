import { mapPanes } from './paneFields'
import { allPanes, findPane, replaceSlot, replaceTab, splitTabOfPane, tabsOfPane } from './tree'
import type { Direction, LayoutNode, PaneNode, SplitNode } from './types'

export const STRIP_SIZE = 26

export type CollapseChange = 'collapse' | 'collapseOthers' | 'expandAll'

function expanded(pane: PaneNode): PaneNode {
  if (!pane.collapsed) return pane
  const { collapsed: _collapsed, ...rest } = pane
  return rest
}

function collapsed(pane: PaneNode): PaneNode {
  return pane.collapsed ? pane : { ...pane, collapsed: true }
}

function mapTab(root: LayoutNode, tab: SplitNode, fn: (pane: PaneNode) => PaneNode): LayoutNode {
  return replaceTab(root, tab.id, (t) => mapPanes(t, fn) as SplitNode)
}

function showPane(root: LayoutNode, paneId: string): LayoutNode {
  const tabs = tabsOfPane(root, paneId)
  if (!tabs || tabs.activeId === paneId) return root
  return replaceSlot(root, tabs.id, () => ({ ...tabs, activeId: paneId }))
}

export function isStrip(node: LayoutNode): boolean {
  if (node.type === 'pane') return node.collapsed === true
  return node.type === 'split' && node.children.every(isStrip)
}

export function canCollapse(tab: SplitNode, paneId: string): boolean {
  const open = allPanes(tab).filter((p) => !p.collapsed)
  return open.length > 1 && open.some((p) => p.id === paneId)
}

export function stripAxis(split: SplitNode, paneId: string): Direction | null {
  for (const child of split.children) {
    if (child.type === 'pane' && child.id === paneId) return split.direction
    const inner = child.type === 'split' ? stripAxis(child, paneId) : null
    if (inner) return inner
  }
  return null
}

function collapsePane(root: LayoutNode, paneId: string): LayoutNode {
  const tab = splitTabOfPane(root, paneId)
  if (!tab || !canCollapse(tab, paneId)) return root
  const next = mapTab(root, tab, (p) => (p.id === paneId ? collapsed(p) : p))
  if (tabsOfPane(next, paneId)?.activeId !== paneId) return next
  const panes = allPanes(tab)
  const at = panes.findIndex((p) => p.id === paneId)
  const nearest = [...panes.slice(at + 1), ...panes.slice(0, at).reverse()].find(
    (p) => !p.collapsed,
  )
  return nearest ? showPane(next, nearest.id) : next
}

function collapseOthers(root: LayoutNode, paneId: string): LayoutNode {
  const tab = splitTabOfPane(root, paneId)
  if (!tab) return root
  const next = mapTab(root, tab, (p) => (p.id === paneId ? expanded(p) : collapsed(p)))
  const shown = tabsOfPane(next, paneId)?.activeId
  return shown && findPane(tab, shown) ? showPane(next, paneId) : next
}

function expandAll(root: LayoutNode, paneId: string): LayoutNode {
  const tab = splitTabOfPane(root, paneId)
  return tab ? mapTab(root, tab, expanded) : root
}

export function changeCollapse(
  root: LayoutNode,
  paneId: string,
  change: CollapseChange,
): LayoutNode {
  if (change === 'collapse') return collapsePane(root, paneId)
  if (change === 'collapseOthers') return collapseOthers(root, paneId)
  return expandAll(root, paneId)
}

function settleTab(tab: SplitNode, activeId: string): SplitNode {
  const panes = allPanes(tab)
  const keep =
    panes.find((p) => p.id === activeId) ?? (panes.every((p) => p.collapsed) ? panes[0] : null)
  return keep?.collapsed ? (mapPanes(tab, (p) => (p === keep ? expanded(p) : p)) as SplitNode) : tab
}

export function settleCollapse(root: LayoutNode): LayoutNode {
  if (root.type === 'pane') return expanded(root)
  if (root.type === 'tabs') {
    const children = root.children.map((c) =>
      c.type === 'pane' ? expanded(c) : settleTab(c, root.activeId),
    )
    return children.every((c, i) => c === root.children[i]) ? root : { ...root, children }
  }
  const children = root.children.map(settleCollapse)
  return children.every((c, i) => c === root.children[i]) ? root : { ...root, children }
}

export function stripSizes(
  sizes: readonly number[],
  strips: readonly boolean[],
  total?: number,
): number[] {
  const open = sizes.reduce((sum, n, i) => (strips[i] ? sum : sum + n), 0)
  const stripped = STRIP_SIZE * strips.filter(Boolean).length
  const room = Math.max(0, (total ?? open + stripped) - stripped)
  return sizes.map((n, i) => (strips[i] ? STRIP_SIZE : open > 0 ? (n / open) * room : 0))
}
