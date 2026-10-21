import { namespacedId } from '@/lib/workspaces/idNamespace'
import type {
  Direction,
  LayoutNode,
  PaneNode,
  SplitNode,
  SurfaceKind,
  TabNode,
  TabsNode,
} from './types'

export type { DropZone } from './types'

let counter = 0

export function resetIds(): void {
  counter = 0
}

function genId(prefix: string): string {
  counter += 1
  return namespacedId(prefix, counter)
}

export function adoptIds(node: LayoutNode): void {
  const n = Number(/-(\d+)$/.exec(node.id)?.[1])
  if (Number.isFinite(n)) counter = Math.max(counter, n)
  if (node.type !== 'pane') for (const child of node.children) adoptIds(child)
}

export const TERMINAL_TITLE = 'Terminal'

const SURFACE_TITLE: Record<SurfaceKind, string> = {
  terminal: TERMINAL_TITLE,
  editor: 'untitled',
  agent: 'claude',
  browser: 'localhost',
  diff: 'Diff',
  chat: 'Chat',
  git: 'Git',
  view: 'View',
  manager: 'Manager',
}

export function createTerminalPane(defaultTitle: string, cwd?: string): PaneNode {
  return {
    type: 'pane',
    id: genId('pane'),
    title: defaultTitle,
    kind: 'terminal',
    cwd,
    defaultTitle: true,
  }
}

export function createPane(kind: SurfaceKind = 'terminal', title?: string, cwd?: string): PaneNode {
  if (kind === 'terminal' && title === undefined) return createTerminalPane(TERMINAL_TITLE, cwd)
  return { type: 'pane', id: genId('pane'), title: title ?? SURFACE_TITLE[kind], kind, cwd }
}

function makeSplit(direction: Direction, children: LayoutNode[]): SplitNode {
  return { type: 'split', id: genId('split'), direction, children, sizes: children.map(() => 1) }
}

export function splitOf(direction: Direction, ...children: LayoutNode[]): SplitNode {
  return makeSplit(direction, children)
}

export function tabsOf(activeId: string, ...children: TabNode[]): TabsNode {
  return { type: 'tabs', id: genId('tabs'), children, activeId }
}

export function firstPaneId(node: LayoutNode): string {
  if (node.type === 'pane') return node.id
  if (node.type === 'tabs') return node.activeId
  return firstPaneId(node.children[0])
}

export function paneIds(node: LayoutNode): string[] {
  if (node.type === 'pane') return [node.id]
  return node.children.flatMap(paneIds)
}

export function slotCount(node: LayoutNode): number {
  if (node.type === 'split') return node.children.reduce((n, c) => n + slotCount(c), 0)
  return 1
}

export function slotKey(node: LayoutNode): string {
  return node.type === 'tabs' ? slotKey(node.children[0]) : node.id
}

export function allPanes(node: LayoutNode): PaneNode[] {
  if (node.type === 'pane') return [node]
  return node.children.flatMap(allPanes)
}

export function untab(tab: LayoutNode): LayoutNode {
  if (tab.type !== 'split' || tab.name === undefined) return tab
  const { name: _name, ...split } = tab
  return split
}

function withoutTabs(tabs: TabsNode, keep: (pane: PaneNode) => boolean): LayoutNode | null {
  const kept = tabs.children.map(
    (c) =>
      (c.type === 'pane'
        ? keep(c)
          ? c
          : null
        : withoutPanes(c, (p) => !keep(p))) as TabNode | null,
  )
  if (kept.every((c, i) => c === tabs.children[i])) return tabs
  const children = kept.filter((c): c is TabNode => c !== null)
  if (children.length === 0) return null
  if (children.length === 1) return untab(children[0])
  const at = tabIndex(tabs, tabs.activeId)
  const own = kept[at]
  if (own && findPane(own, tabs.activeId)) return { ...tabs, children }
  const later = kept.slice(at + 1).find((c): c is TabNode => c !== null)
  const survivor = own ?? later ?? children[children.length - 1]
  return { ...tabs, children, activeId: firstPaneId(survivor) }
}

export function withoutPanes(
  root: LayoutNode,
  drop: (pane: PaneNode) => boolean,
): LayoutNode | null {
  if (root.type === 'pane') return drop(root) ? null : root
  if (root.type === 'tabs') return withoutTabs(root, (p) => !drop(p))
  const children: LayoutNode[] = []
  const sizes: number[] = []
  root.children.forEach((child, i) => {
    const kept = withoutPanes(child, drop)
    if (kept) {
      children.push(kept)
      sizes.push(root.sizes[i] ?? 1)
    }
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  const same =
    children.length === root.children.length && children.every((c, i) => c === root.children[i])
  return same ? root : { ...root, children, sizes }
}

export function findPane(node: LayoutNode, id: string): PaneNode | null {
  return allPanes(node).find((p) => p.id === id) ?? null
}

export function adjacentTab(root: LayoutNode, paneId: string, step: 1 | -1): string | null {
  const tabs = tabsOfPane(root, paneId)
  if (!tabs || tabs.children.length < 2) return null
  const at = tabIndex(tabs, paneId)
  const next = (at + step + tabs.children.length) % tabs.children.length
  return firstPaneId(tabs.children[next])
}

export function tabNeighbor(root: LayoutNode, paneId: string, step: 1 | -1): string | null {
  const tabs = tabsOfPane(root, paneId)
  if (!tabs) return null
  return tabs.children[tabIndex(tabs, paneId) + step]?.id ?? null
}

export function tabIndex(tabs: TabsNode, paneId: string): number {
  return tabs.children.findIndex((c) => (c.type === 'pane' ? c.id === paneId : findPane(c, paneId)))
}

export function tabsOfPane(node: LayoutNode, paneId: string): TabsNode | null {
  if (node.type === 'pane') return null
  if (node.type === 'tabs') return tabIndex(node, paneId) === -1 ? null : node
  for (const child of node.children) {
    const found = tabsOfPane(child, paneId)
    if (found) return found
  }
  return null
}

export function backgroundTabAnchor(
  root: LayoutNode,
  callerId: string,
  openedIds: readonly string[],
): string {
  const stack = tabsOfPane(root, callerId)
  if (!stack) return callerId
  const inStack = openedIds.filter((id) => tabsOfPane(root, id)?.id === stack.id)
  return inStack[inStack.length - 1] ?? callerId
}

function tabOfPane(root: LayoutNode, paneId: string): TabNode | null {
  const tabs = tabsOfPane(root, paneId)
  return tabs ? tabs.children[tabIndex(tabs, paneId)] : null
}

export function splitTabOfPane(root: LayoutNode, paneId: string): SplitNode | null {
  const tab = tabOfPane(root, paneId)
  return tab?.type === 'split' ? tab : null
}

export function tabIdOf(root: LayoutNode, paneId: string): string | null {
  return tabOfPane(root, paneId)?.id ?? (findPane(root, paneId) ? paneId : null)
}

export function shownTab(tabs: TabsNode): TabNode {
  return tabs.children[tabIndex(tabs, tabs.activeId)] ?? tabs.children[0]
}

function splitTabs(node: LayoutNode): SplitNode[] {
  if (node.type === 'pane') return []
  if (node.type === 'tabs') return node.children.filter((c): c is SplitNode => c.type === 'split')
  return node.children.flatMap(splitTabs)
}

export function findSplitTab(root: LayoutNode, splitId: string): SplitNode | null {
  return splitTabs(root).find((t) => t.id === splitId) ?? null
}

export function findSplitTabByName(root: LayoutNode, name: string): SplitNode | null {
  return splitTabs(root).find((t) => t.name === name) ?? null
}

export function setSplitTabName(root: LayoutNode, tabId: string, name: string | null): LayoutNode {
  return replaceTab(root, tabId, (tab) => {
    if (tab.type !== 'split' || (tab.name ?? null) === name) return tab
    if (name !== null) return { ...tab, name }
    const { name: _name, ...unnamed } = tab
    return unnamed
  })
}

export function focusIdOf(root: LayoutNode, id: string): string | null {
  if (findPane(root, id)) return id
  const tab = findSplitTab(root, id)
  if (!tab) return null
  const active = tabsOfPane(root, firstPaneId(tab))?.activeId
  return active && findPane(tab, active) ? active : firstPaneId(tab)
}

export function slotPaneOfKind(
  root: LayoutNode,
  paneId: string,
  kind: SurfaceKind,
): PaneNode | null {
  const tabs = tabsOfPane(root, paneId)
  const slot = tabs ? allPanes(tabs) : [findPane(root, paneId)]
  return slot.find((p): p is PaneNode => p?.kind === kind) ?? null
}

export function isPaneShown(root: LayoutNode, paneId: string): boolean {
  const tabs = tabsOfPane(root, paneId)
  if (!tabs) return findPane(root, paneId) !== null
  return (
    tabIndex(tabs, tabs.activeId) === tabIndex(tabs, paneId) && !findPane(tabs, paneId)?.collapsed
  )
}

export function slotIdOf(root: LayoutNode, paneId: string): string | null {
  const tabs = tabsOfPane(root, paneId)
  if (tabs) return tabs.id
  return findPane(root, paneId) ? paneId : null
}

export function replaceSlot(
  root: LayoutNode,
  slotId: string,
  fn: (slot: PaneNode | TabsNode, parent: SplitNode | null, index: number) => LayoutNode,
): LayoutNode {
  if (root.type !== 'split') return root.id === slotId ? fn(root, null, 0) : root
  const recur = (split: SplitNode): SplitNode => {
    const idx = split.children.findIndex((c) => c.type !== 'split' && c.id === slotId)
    if (idx !== -1) {
      const slot = split.children[idx] as PaneNode | TabsNode
      const replaced = fn(slot, split, idx)
      if (replaced.type === 'split' && replaced.id === split.id) return replaced
      const children = [...split.children]
      children[idx] = replaced
      return { ...split, children }
    }
    const children = split.children.map((c) => (c.type === 'split' ? recur(c) : c))
    return children.every((c, i) => c === split.children[i]) ? split : { ...split, children }
  }
  return recur(root)
}

function insertBeside(
  root: LayoutNode,
  targetPaneId: string,
  node: LayoutNode,
  direction: Direction,
  before: boolean,
): LayoutNode {
  const slotId = slotIdOf(root, targetPaneId)
  if (!slotId) return root
  return replaceSlot(root, slotId, (slot, parent, idx) => {
    if (parent && parent.direction === direction) {
      const children = [...parent.children]
      const sizes = [...parent.sizes]
      const share = sizes[idx] ?? 1
      children.splice(before ? idx : idx + 1, 0, node)
      sizes.splice(idx, 1, share / 2, share / 2)
      return { ...parent, children, sizes }
    }
    return makeSplit(direction, before ? [node, slot] : [slot, node])
  })
}

function insertNear(
  split: SplitNode,
  paneId: string,
  node: LayoutNode,
  direction: Direction,
  before: boolean,
): SplitNode {
  const idx = split.children.findIndex((c) => c.type === 'pane' && c.id === paneId)
  if (idx === -1) {
    const children = split.children.map((c) =>
      c.type === 'split' && findPane(c, paneId)
        ? insertNear(c, paneId, node, direction, before)
        : c,
    )
    return { ...split, children }
  }
  const children = [...split.children]
  if (split.direction === direction) {
    const sizes = [...split.sizes]
    const share = sizes[idx] ?? 1
    children.splice(before ? idx : idx + 1, 0, node)
    sizes.splice(idx, 1, share / 2, share / 2)
    return { ...split, children, sizes }
  }
  const pane = children[idx]
  children[idx] = makeSplit(direction, before ? [node, pane] : [pane, node])
  return { ...split, children }
}

function canJoinTab(node: LayoutNode): boolean {
  if (node.type === 'pane') return true
  return node.type === 'split' && node.children.every(canJoinTab)
}

function insertInTab(
  root: LayoutNode,
  targetPaneId: string,
  node: LayoutNode,
  direction: Direction,
  before: boolean,
): LayoutNode {
  const tabs = tabsOfPane(root, targetPaneId)
  if (!tabs) return root
  const at = tabIndex(tabs, targetPaneId)
  const tab = tabs.children[at]
  const children = [...tabs.children]
  children[at] =
    tab.type === 'pane'
      ? makeSplit(direction, before ? [node, tab] : [tab, node])
      : insertNear(tab, targetPaneId, node, direction, before)
  return replaceSlot(root, tabs.id, () => ({ ...tabs, children }))
}

export function placeBeside(
  root: LayoutNode,
  targetPaneId: string,
  node: LayoutNode,
  direction: Direction,
  before: boolean,
): LayoutNode {
  const inTab = tabsOfPane(root, targetPaneId) !== null && canJoinTab(node)
  return inTab
    ? insertInTab(root, targetPaneId, node, direction, before)
    : insertBeside(root, targetPaneId, node, direction, before)
}

export function splitPane(
  root: LayoutNode,
  targetId: string,
  direction: Direction,
  newPane: PaneNode = createPane(),
): { root: LayoutNode; newPaneId: string | null } {
  if (!findPane(root, targetId)) return { root, newPaneId: null }
  return { root: placeBeside(root, targetId, newPane, direction, false), newPaneId: newPane.id }
}

export function splitBeside(
  root: LayoutNode,
  targetId: string,
  direction: Direction,
  newPane: PaneNode = createPane(),
): { root: LayoutNode; newPaneId: string | null } {
  if (!findPane(root, targetId)) return { root, newPaneId: null }
  return { root: insertBeside(root, targetId, newPane, direction, false), newPaneId: newPane.id }
}

export function addTab(
  root: LayoutNode,
  targetId: string,
  tab: TabNode,
  background = false,
): LayoutNode {
  const slotId = slotIdOf(root, targetId)
  if (!slotId) return root
  const shownId = firstPaneId(tab)
  return replaceSlot(root, slotId, (slot) => {
    if (slot.type === 'pane') return tabsOf(background ? slot.id : shownId, slot, tab)
    const children = [...slot.children]
    children.splice(tabIndex(slot, targetId) + 1, 0, tab)
    return { ...slot, children, activeId: background ? slot.activeId : shownId }
  })
}

export function insertTab(
  root: LayoutNode,
  nearId: string,
  tab: TabNode,
  after: boolean,
): LayoutNode {
  const slotId = slotIdOf(root, nearId)
  if (!slotId) return root
  return replaceSlot(root, slotId, (slot) => {
    if (slot.type === 'pane') return tabsOf(slot.id, ...(after ? [slot, tab] : [tab, slot]))
    const children = [...slot.children]
    children.splice(tabIndex(slot, nearId) + (after ? 1 : 0), 0, tab)
    return { ...slot, children }
  })
}

export function replaceTab(
  root: LayoutNode,
  tabId: string,
  fn: (tab: TabNode) => TabNode,
): LayoutNode {
  const tab = tabSource(root, tabId)
  const tabs = tab ? tabsOfPane(root, firstPaneId(tab)) : null
  if (!tab || !tabs?.children.includes(tab)) return root
  const next = fn(tab)
  if (next === tab) return root
  const children = tabs.children.map((c) => (c === tab ? next : c))
  const lost = findPane(tab, tabs.activeId) && !findPane(next, tabs.activeId)
  const activeId = lost ? firstPaneId(next) : tabs.activeId
  return replaceSlot(root, tabs.id, () => ({ ...tabs, children, activeId }))
}

export function selectTab(root: LayoutNode, paneId: string): LayoutNode {
  const tabs = tabsOfPane(root, paneId)
  if (!tabs || tabs.activeId === paneId) return root
  return replaceSlot(root, tabs.id, () => ({ ...tabs, activeId: paneId }))
}

export function closePane(root: LayoutNode, targetId: string): LayoutNode {
  if (root.type === 'pane') return root

  const prune = (node: LayoutNode): LayoutNode | null => {
    if (node.type === 'pane') return node.id === targetId ? null : node
    if (node.type === 'tabs') return withoutTabs(node, (p) => p.id !== targetId)
    const kept: LayoutNode[] = []
    const sizes: number[] = []
    node.children.forEach((child, i) => {
      const r = prune(child)
      if (r) {
        kept.push(r)
        sizes.push(node.sizes[i] ?? 1)
      }
    })
    if (kept.length === 0) return null
    if (kept.length === 1) return kept[0]
    if (kept.length === node.children.length && kept.every((c, i) => c === node.children[i])) {
      return node
    }
    return { ...node, children: kept, sizes }
  }

  return prune(root) ?? root
}

export function mergeLayouts(target: LayoutNode, source: LayoutNode): LayoutNode {
  return makeSplit('horizontal', [target, source])
}

export function tabSource(root: LayoutNode, id: string): TabNode | null {
  return findPane(root, id) ?? findSplitTab(root, id)
}
