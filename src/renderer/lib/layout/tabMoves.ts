import type { PanePlacement } from '@shared/workspaces/workspaceApi'
import {
  addTab,
  allPanes,
  findPane,
  firstPaneId,
  focusIdOf,
  paneIds,
  placeBeside,
  replaceSlot,
  slotIdOf,
  splitOf,
  splitTabOfPane,
  tabIndex,
  tabNeighbor,
  tabSource,
  tabsOf,
  tabsOfPane,
  untab,
  withoutPanes,
} from './tree'
import type { Direction, DropZone, LayoutNode, SplitNode, TabNode } from './types'

export function movePane(
  root: LayoutNode,
  sourceId: string,
  targetId: string,
  zone: DropZone,
): LayoutNode {
  const source = tabSource(root, sourceId)
  if (!source || !findPane(root, targetId) || findPane(source, targetId)) return root
  const moving = new Set(paneIds(source))
  const detached = withoutPanes(root, (p) => moving.has(p.id))
  if (!detached) return root

  if (zone === 'center') {
    const tabs = tabsOfPane(root, targetId)
    if (tabs?.children.some((c) => c.id === sourceId)) return root
    return addTab(detached, targetId, source)
  }

  const direction: Direction = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical'
  const before = zone === 'left' || zone === 'top'
  return placeBeside(detached, targetId, untab(source), direction, before)
}

function parentOf(node: LayoutNode, childId: string): SplitNode | null {
  if (node.type === 'pane') return null
  if (node.type === 'split' && node.children.some((c) => c.type !== 'split' && c.id === childId)) {
    return node
  }
  for (const child of node.children) {
    const found = parentOf(child, childId)
    if (found) return found
  }
  return null
}

function lastPaneId(node: LayoutNode): string {
  const panes = allPanes(node)
  return panes[panes.length - 1].id
}

export function placementOf(root: LayoutNode, paneId: string): PanePlacement | null {
  const tabs = tabsOfPane(root, paneId)
  const tab = tabs ? tabs.children[tabIndex(tabs, paneId)] : null
  if (tabs && tab?.type === 'pane') {
    const index = tabs.children.indexOf(tab)
    const neighbor = tabs.children[index - 1] ?? tabs.children[index + 1]
    return { paneId: firstPaneId(neighbor), zone: 'center' }
  }
  const anchorId = tab ? paneId : slotIdOf(root, paneId)
  const parent = anchorId ? parentOf(root, anchorId) : null
  if (!parent) return null
  const index = parent.children.findIndex((c) => c.type !== 'split' && c.id === anchorId)
  const horizontal = parent.direction === 'horizontal'
  const before = parent.children[index - 1]
  if (before) return { paneId: lastPaneId(before), zone: horizontal ? 'right' : 'bottom' }
  return { paneId: firstPaneId(parent.children[index + 1]), zone: horizontal ? 'left' : 'top' }
}

function tabsOfSlot(node: LayoutNode): TabNode[] | null {
  if (node.type === 'pane') return [node]
  if (node.type === 'tabs') return node.children
  return null
}

export function graftNode(
  root: LayoutNode | null,
  node: LayoutNode,
  beside?: PanePlacement,
): LayoutNode {
  if (!root) return node
  const anchor = beside && findPane(root, beside.paneId) ? beside : null
  if (!anchor) return splitOf('horizontal', root, node)
  const tabs = anchor.zone === 'center' ? tabsOfSlot(node) : null
  if (tabs) {
    let next = root
    let after = anchor.paneId
    for (const tab of tabs) {
      next = addTab(next, after, tab)
      after = firstPaneId(tab)
    }
    return next
  }
  const zone = anchor.zone === 'center' ? 'right' : anchor.zone
  const direction: Direction = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical'
  return placeBeside(root, anchor.paneId, node, direction, zone === 'left' || zone === 'top')
}

export function moveTab(
  root: LayoutNode,
  sourceId: string,
  targetId: string,
  after: boolean,
): LayoutNode {
  const source = tabSource(root, sourceId)
  const targetPaneId = focusIdOf(root, targetId)
  if (sourceId === targetId || !source || !targetPaneId || findPane(source, targetPaneId)) {
    return root
  }
  const shownId = focusIdOf(root, sourceId) ?? firstPaneId(source)
  const sameStack = tabsOfPane(root, targetPaneId)?.children.includes(source) ?? false
  const moving = new Set(paneIds(source))
  const base = sameStack ? root : withoutPanes(root, (p) => moving.has(p.id))
  const slotId = base ? slotIdOf(base, targetPaneId) : null
  if (!base || !slotId) return root
  return replaceSlot(base, slotId, (slot) => {
    const tabs = (slot.type === 'pane' ? [slot] : slot.children).filter((c) => c !== source)
    const at = tabs.findIndex((c) =>
      c.type === 'pane' ? c.id === targetPaneId : findPane(c, targetPaneId),
    )
    tabs.splice(at + (after ? 1 : 0), 0, source)
    return slot.type === 'pane'
      ? tabsOf(shownId, ...tabs)
      : { ...slot, children: tabs, activeId: shownId }
  })
}

export interface TakenTab {
  tab: TabNode
  rest: LayoutNode | null
  successor: string | null
}

export function takeTab(root: LayoutNode, id: string): TakenTab | null {
  const tab = tabSource(root, id)
  if (!tab) return null
  const moving = new Set(paneIds(tab))
  const rest = withoutPanes(root, (p) => moving.has(p.id))
  if (!rest) return { tab, rest, successor: null }
  const split = tab.type === 'pane' ? splitTabOfPane(root, tab.id) : null
  const sibling = split ? paneIds(split).find((paneId) => !moving.has(paneId)) : undefined
  const neighbor =
    sibling ?? tabNeighbor(root, firstPaneId(tab), -1) ?? tabNeighbor(root, firstPaneId(tab), 1)
  return { tab, rest, successor: (neighbor && focusIdOf(rest, neighbor)) ?? firstPaneId(rest) }
}

export function landTab(root: LayoutNode | null, tab: TabNode, anchorId: string): LayoutNode {
  if (!root) return untab(tab)
  return addTab(root, findPane(root, anchorId) ? anchorId : firstPaneId(root), tab)
}
