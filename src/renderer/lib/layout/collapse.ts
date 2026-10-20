import { mapPanes } from './paneFields'
import {
  allPanes,
  findPane,
  findSplitTab,
  firstPaneId,
  replaceTab,
  selectTab,
  splitTabOfPane,
  tabsOfPane,
} from './tree'
import type { Direction, LayoutNode, PaneNode, SplitNode, TabNode } from './types'

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
  return nearest ? selectTab(next, nearest.id) : next
}

function collapseOthers(root: LayoutNode, paneId: string): LayoutNode {
  const tab = splitTabOfPane(root, paneId)
  if (!tab) return root
  const next = mapTab(root, tab, (p) => (p.id === paneId ? expanded(p) : collapsed(p)))
  const shown = tabsOfPane(next, paneId)?.activeId
  return shown && findPane(tab, shown) ? selectTab(next, paneId) : next
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

function unfolded(split: SplitNode): SplitNode {
  if (!split.folded) return split
  const { folded: _folded, ...rest } = split
  return rest
}

function settleInner(node: LayoutNode): LayoutNode {
  if (node.type !== 'split') return node
  const children = node.children.map(settleInner)
  return unfolded(children.every((c, i) => c === node.children[i]) ? node : { ...node, children })
}

function settleTab(tab: SplitNode, activeId: string): SplitNode {
  const panes = allPanes(tab)
  const keep =
    panes.find((p) => p.id === activeId) ?? (panes.every((p) => p.collapsed) ? panes[0] : null)
  const opened = keep?.collapsed
    ? (mapPanes(tab, (p) => (p === keep ? expanded(p) : p)) as SplitNode)
    : tab
  const children = opened.children.map(settleInner)
  const inner = children.every((c, i) => c === opened.children[i])
    ? opened
    : { ...opened, children }
  return panes.some((p) => p.id === activeId) ? unfolded(inner) : inner
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
  return unfolded(children.every((c, i) => c === root.children[i]) ? root : { ...root, children })
}

function openPaneOf(tab: TabNode): string | null {
  if (tab.type === 'pane') return tab.id
  if (tab.folded) return null
  return allPanes(tab).find((p) => !p.collapsed)?.id ?? null
}

export function foldSplitTab(root: LayoutNode, tabId: string): LayoutNode {
  const tab = findSplitTab(root, tabId)
  const tabs = tab ? tabsOfPane(root, firstPaneId(tab)) : null
  if (!tab || !tabs || tab.folded) return root
  const folded = replaceTab(root, tabId, () => ({ ...tab, folded: true }))
  if (!findPane(tab, tabs.activeId)) return folded
  const at = tabs.children.indexOf(tab)
  const shown = [...tabs.children.slice(at + 1), ...tabs.children.slice(0, at).reverse()]
    .map(openPaneOf)
    .find((id) => id !== null)
  return shown ? selectTab(folded, shown) : root
}

export function isTucked(root: LayoutNode, paneId: string): boolean {
  return findPane(root, paneId)?.collapsed === true || splitTabOfPane(root, paneId)?.folded === true
}

export function stripSizes(
  sizes: readonly number[],
  strips: readonly boolean[],
  total?: number,
  opened: readonly boolean[] = [],
): number[] {
  const sum = (keep: (i: number) => boolean) =>
    sizes.reduce((acc, n, i) => (keep(i) ? acc + n : acc), 0)
  const stripped = STRIP_SIZE * strips.filter(Boolean).length
  const room = Math.max(0, (total ?? sum((i) => !strips[i]) + stripped) - stripped)
  const back = sum((i) => !strips[i] && opened[i] === true)
  const rest = sum((i) => !strips[i] && opened[i] !== true)
  const restored = back < room && rest > 0
  const share = restored ? room - back : room
  const pool = restored ? rest : back + rest
  return sizes.map((n, i) => {
    if (strips[i]) return STRIP_SIZE
    if (restored && opened[i]) return n
    return pool > 0 ? (n / pool) * share : 0
  })
}
