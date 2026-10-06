import type { AgentResume } from '@shared/agentResume'
import { type BrowserProfile, parseBrowserProfile } from '@shared/browserProfile'
import { isRemotePath } from '@shared/remoteFolders'
import type { PanePlacement } from '@shared/types'
import { namespacedId } from '../lib/idNamespace'
import type {
  Direction,
  DropZone,
  LayoutNode,
  PaneNode,
  SplitNode,
  SurfaceKind,
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
  extension: 'Extension',
  diff: 'Diff',
  chat: 'Chat',
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

export function tabsOf(activeId: string, ...children: PaneNode[]): TabsNode {
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

export function equalizeSizes(node: LayoutNode): LayoutNode {
  if (node.type !== 'split') return node
  const children = node.children.map(equalizeSizes)
  const sizes = node.children.map(() => 1)
  const sameChildren = children.every((c, i) => c === node.children[i])
  const sameSizes = node.sizes.length === sizes.length && node.sizes.every((n) => n === 1)
  if (sameChildren && sameSizes) return node
  return { ...node, children, sizes }
}

export function allPanes(node: LayoutNode): PaneNode[] {
  if (node.type === 'pane') return [node]
  return node.children.flatMap(allPanes)
}

function mapPanes(node: LayoutNode, fn: (pane: PaneNode) => PaneNode): LayoutNode {
  if (node.type === 'pane') return fn(node)
  if (node.type === 'tabs') {
    const children = node.children.map(fn)
    return children.every((c, i) => c === node.children[i]) ? node : { ...node, children }
  }
  const children = node.children.map((c) => mapPanes(c, fn))
  return children.every((c, i) => c === node.children[i]) ? node : { ...node, children }
}

function mapPane(root: LayoutNode, paneId: string, fn: (pane: PaneNode) => PaneNode): LayoutNode {
  return mapPanes(root, (p) => (p.id === paneId ? fn(p) : p))
}

export function setResumePending(root: LayoutNode, paneId: string, pending: boolean): LayoutNode {
  return mapPane(root, paneId, (p) => {
    if (Boolean(p.resumePending) === pending) return p
    if (pending) return { ...p, resumePending: true }
    const { resumePending: _pending, ...rest } = p
    return rest
  })
}

export function setPaneCwd(root: LayoutNode, paneId: string, cwd: string): LayoutNode {
  return mapPane(root, paneId, (p) => (p.cwd === cwd ? p : { ...p, cwd }))
}

export function setPaneUrl(root: LayoutNode, paneId: string, url: string): LayoutNode {
  return mapPane(root, paneId, (p) => (p.url === url ? p : { ...p, url }))
}

function named(pane: PaneNode, title: string): PaneNode {
  const { defaultTitle: _default, ...rest } = pane
  return { ...rest, title }
}

export function setPaneTitle(root: LayoutNode, paneId: string, title: string): LayoutNode {
  return mapPane(root, paneId, (p) =>
    p.titlePinned || (p.title === title && !p.defaultTitle) ? p : named(p, title),
  )
}

export function renamePane(root: LayoutNode, paneId: string, title: string): LayoutNode {
  const name = title.trim()
  return mapPane(root, paneId, (p) => {
    if (name && p.title === name && p.titlePinned) return p
    if (name) return { ...named(p, name), titlePinned: true }
    if (!p.titlePinned) return p
    const { titlePinned: _pinned, ...rest } = p
    return rest
  })
}

function withDefaultTitle(pane: PaneNode, title: string): PaneNode {
  return pane.defaultTitle && pane.title !== title ? { ...pane, title } : pane
}

export function setDefaultPaneTitle(root: LayoutNode, paneId: string, title: string): LayoutNode {
  return mapPane(root, paneId, (p) => withDefaultTitle(p, title))
}

export function setDefaultPaneTitles(root: LayoutNode, title: string): LayoutNode {
  return mapPanes(root, (p) => withDefaultTitle(p, title))
}

export function setPaneResume(root: LayoutNode, paneId: string, resume: AgentResume): LayoutNode {
  return mapPane(root, paneId, (p) =>
    p.resume?.agent === resume.agent && p.resume.id === resume.id ? p : { ...p, resume },
  )
}

export function setPaneHibernated(
  root: LayoutNode,
  paneId: string,
  hibernated: boolean,
): LayoutNode {
  return mapPane(root, paneId, (p) => {
    if (Boolean(p.hibernated) === hibernated) return p
    if (hibernated) return { ...p, hibernated: true }
    const { hibernated: _hibernated, ...awake } = p
    return awake
  })
}

export function setPaneLocked(root: LayoutNode, paneId: string, locked: boolean): LayoutNode {
  return mapPane(root, paneId, (p) => {
    if (Boolean(p.locked) === locked) return p
    if (locked) return { ...p, locked: true }
    const { locked: _locked, ...open } = p
    return open
  })
}

export function hasLockedPane(root: LayoutNode): boolean {
  return allPanes(root).some((p) => p.locked === true)
}

export function firstPaneOfKind(node: LayoutNode, kind: SurfaceKind): PaneNode | null {
  return allPanes(node).find((p) => p.kind === kind) ?? null
}

export function setPaneEditor(
  root: LayoutNode,
  paneId: string,
  title: string,
  filePath: string,
): LayoutNode {
  if (isRemotePath(filePath)) {
    return mapPane(root, paneId, ({ cwd: _local, ...p }) => ({
      ...p,
      kind: 'editor',
      title,
      filePath,
    }))
  }
  const slash = filePath.lastIndexOf('/')
  const cwd = slash > 0 ? filePath.slice(0, slash) : '/'
  return mapPane(root, paneId, (p) => ({ ...named(p, title), kind: 'editor', filePath, cwd }))
}

function titleFromUrl(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

export function setPaneBrowser(
  root: LayoutNode,
  paneId: string,
  url: string,
  profile?: BrowserProfile,
): LayoutNode {
  return mapPane(root, paneId, (p) => {
    const next: PaneNode = { ...named(p, titleFromUrl(url)), kind: 'browser', url }
    if (profile === undefined) return next
    const { browserProfile: _previous, ...rest } = next
    return profile === 'shared' ? { ...rest, browserProfile: 'shared' } : rest
  })
}

export function paneBrowserProfile(pane: PaneNode): BrowserProfile {
  return parseBrowserProfile(pane.browserProfile)
}

export function firstBrowserPane(node: LayoutNode, profile: BrowserProfile): PaneNode | null {
  return (
    allPanes(node).find((p) => p.kind === 'browser' && paneBrowserProfile(p) === profile) ?? null
  )
}

export function setPaneExtension(
  root: LayoutNode,
  paneId: string,
  extensionId: string,
  title: string,
): LayoutNode {
  return mapPane(root, paneId, (p) => ({
    ...named(p, title),
    kind: 'extension',
    extensionId,
    cwd: undefined,
  }))
}

export function setPaneChat(
  root: LayoutNode,
  paneId: string,
  title: string,
  sessionId?: string,
): LayoutNode {
  return mapPane(root, paneId, (p) => ({
    type: 'pane',
    id: p.id,
    kind: 'chat',
    title,
    ...(sessionId ? { chatSessionId: sessionId } : {}),
  }))
}

export function setPaneView(
  root: LayoutNode,
  paneId: string,
  viewName: string,
  title: string,
): LayoutNode {
  return mapPane(root, paneId, (p) => ({ type: 'pane', id: p.id, kind: 'view', title, viewName }))
}

export function setPaneDiff(
  root: LayoutNode,
  paneId: string,
  title: string,
  cwd?: string,
): LayoutNode {
  return mapPane(root, paneId, (p) => ({
    type: 'pane',
    id: p.id,
    kind: 'diff',
    title,
    ...(cwd ? { cwd } : {}),
  }))
}

function withoutTabs(tabs: TabsNode, keep: (pane: PaneNode) => boolean): LayoutNode | null {
  const children = tabs.children.filter(keep)
  if (children.length === tabs.children.length) return tabs
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  if (children.some((c) => c.id === tabs.activeId)) return { ...tabs, children }
  const at = tabs.children.findIndex((c) => c.id === tabs.activeId)
  const survivor = tabs.children.slice(at + 1).find(keep) ?? children[children.length - 1]
  return { ...tabs, children, activeId: survivor.id }
}

export function isRemoteFilePane(pane: PaneNode): boolean {
  return pane.kind === 'editor' && isRemotePath(pane.filePath)
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

export function findExtensionPane(node: LayoutNode, extensionId: string): PaneNode | null {
  return allPanes(node).find((p) => p.kind === 'extension' && p.extensionId === extensionId) ?? null
}

export function findViewPane(node: LayoutNode, viewName: string): PaneNode | null {
  return allPanes(node).find((p) => p.kind === 'view' && p.viewName === viewName) ?? null
}

export function findPane(node: LayoutNode, id: string): PaneNode | null {
  return allPanes(node).find((p) => p.id === id) ?? null
}

export function adjacentTab(root: LayoutNode, paneId: string, step: 1 | -1): string | null {
  const tabs = tabsOfPane(root, paneId)
  if (!tabs || tabs.children.length < 2) return null
  const at = tabs.children.findIndex((c) => c.id === paneId)
  const next = (at + step + tabs.children.length) % tabs.children.length
  return tabs.children[next].id
}

export function tabsOfPane(node: LayoutNode, paneId: string): TabsNode | null {
  if (node.type === 'pane') return null
  if (node.type === 'tabs') return node.children.some((c) => c.id === paneId) ? node : null
  for (const child of node.children) {
    const found = tabsOfPane(child, paneId)
    if (found) return found
  }
  return null
}

export function slotPaneOfKind(
  root: LayoutNode,
  paneId: string,
  kind: SurfaceKind,
): PaneNode | null {
  const tabs = tabsOfPane(root, paneId)
  const slot = tabs ? tabs.children : [findPane(root, paneId)]
  return slot.find((p): p is PaneNode => p?.kind === kind) ?? null
}

export function isPaneShown(root: LayoutNode, paneId: string): boolean {
  const tabs = tabsOfPane(root, paneId)
  return tabs ? tabs.activeId === paneId : findPane(root, paneId) !== null
}

export type FocusDirection = 'left' | 'right' | 'up' | 'down'

interface SlotRect {
  paneId: string
  shownIds: readonly string[]
  x: number
  y: number
  w: number
  h: number
}

function slotRects(node: LayoutNode, x: number, y: number, w: number, h: number): SlotRect[] {
  if (node.type === 'pane') return [{ paneId: node.id, shownIds: [node.id], x, y, w, h }]
  if (node.type === 'tabs') {
    const shownIds = node.children.map((c) => c.id)
    return [{ paneId: node.activeId, shownIds, x, y, w, h }]
  }
  const total = node.sizes.reduce((a, b) => a + b, 0) || node.children.length
  const out: SlotRect[] = []
  let offset = 0
  node.children.forEach((child, i) => {
    const share = (node.sizes[i] ?? 1) / total
    if (node.direction === 'horizontal') {
      out.push(...slotRects(child, x + offset * w, y, share * w, h))
    } else {
      out.push(...slotRects(child, x, y + offset * h, w, share * h))
    }
    offset += share
  })
  return out
}

const EDGE_EPSILON = 1e-6

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0)
}

export function paneInDirection(
  root: LayoutNode,
  paneId: string,
  direction: FocusDirection,
): string | null {
  const rects = slotRects(root, 0, 0, 1, 1)
  const from = rects.find((r) => r.shownIds.includes(paneId))
  if (!from) return null
  const horizontal = direction === 'left' || direction === 'right'
  const candidates = rects.filter((r) => {
    if (r === from) return false
    const touches =
      direction === 'left'
        ? Math.abs(r.x + r.w - from.x) < EDGE_EPSILON
        : direction === 'right'
          ? Math.abs(from.x + from.w - r.x) < EDGE_EPSILON
          : direction === 'up'
            ? Math.abs(r.y + r.h - from.y) < EDGE_EPSILON
            : Math.abs(from.y + from.h - r.y) < EDGE_EPSILON
    const shared = horizontal
      ? overlap(r.y, r.y + r.h, from.y, from.y + from.h)
      : overlap(r.x, r.x + r.w, from.x, from.x + from.w)
    return touches && shared > EDGE_EPSILON
  })
  const center = horizontal ? from.y + from.h / 2 : from.x + from.w / 2
  const distance = (r: SlotRect): number =>
    horizontal ? Math.abs(r.y + r.h / 2 - center) : Math.abs(r.x + r.w / 2 - center)
  const best = candidates.sort((a, b) => distance(a) - distance(b))[0]
  return best ? best.paneId : null
}

function slotIdOf(root: LayoutNode, paneId: string): string | null {
  const tabs = tabsOfPane(root, paneId)
  if (tabs) return tabs.id
  return findPane(root, paneId) ? paneId : null
}

function replaceSlot(
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

export function splitPane(
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
  pane: PaneNode,
  background = false,
): LayoutNode {
  const slotId = slotIdOf(root, targetId)
  if (!slotId) return root
  return replaceSlot(root, slotId, (slot) => {
    if (slot.type === 'pane') return tabsOf(background ? slot.id : pane.id, slot, pane)
    const children = [...slot.children]
    children.splice(children.findIndex((c) => c.id === targetId) + 1, 0, pane)
    return { ...slot, children, activeId: background ? slot.activeId : pane.id }
  })
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

export function setSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (root.type !== 'split') return root
  const recur = (node: SplitNode): SplitNode => {
    if (node.id === splitId) return { ...node, sizes }
    return {
      ...node,
      children: node.children.map((c) => (c.type === 'split' ? recur(c) : c)),
    }
  }
  return recur(root)
}

export function mergeLayouts(target: LayoutNode, source: LayoutNode): LayoutNode {
  return makeSplit('horizontal', [target, source])
}

export function movePane(
  root: LayoutNode,
  sourceId: string,
  targetId: string,
  zone: DropZone,
): LayoutNode {
  if (sourceId === targetId) return root
  const source = findPane(root, sourceId)
  if (!source || !findPane(root, targetId)) return root

  if (zone === 'center') {
    const tabs = tabsOfPane(root, targetId)
    if (tabs?.children.some((c) => c.id === sourceId)) return root
    return addTab(closePane(root, sourceId), targetId, source)
  }

  const detached = closePane(root, sourceId)
  const direction: Direction = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical'
  const before = zone === 'left' || zone === 'top'
  return insertBeside(detached, targetId, source, direction, before)
}

function parentOfSlot(node: LayoutNode, slotId: string): SplitNode | null {
  if (node.type !== 'split') return null
  if (node.children.some((c) => c.type !== 'split' && c.id === slotId)) return node
  for (const child of node.children) {
    const found = parentOfSlot(child, slotId)
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
  if (tabs && tabs.children.length > 1) {
    const index = tabs.children.findIndex((c) => c.id === paneId)
    const neighbor = tabs.children[index - 1] ?? tabs.children[index + 1]
    return { paneId: neighbor.id, zone: 'center' }
  }
  const slotId = slotIdOf(root, paneId)
  const parent = slotId ? parentOfSlot(root, slotId) : null
  if (!parent) return null
  const index = parent.children.findIndex((c) => c.type !== 'split' && c.id === slotId)
  const horizontal = parent.direction === 'horizontal'
  const before = parent.children[index - 1]
  if (before) return { paneId: lastPaneId(before), zone: horizontal ? 'right' : 'bottom' }
  return { paneId: firstPaneId(parent.children[index + 1]), zone: horizontal ? 'left' : 'top' }
}

function panesOfSlot(node: LayoutNode): PaneNode[] | null {
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
  if (!anchor) return makeSplit('horizontal', [root, node])
  const tabs = anchor.zone === 'center' ? panesOfSlot(node) : null
  if (tabs) {
    let next = root
    let after = anchor.paneId
    for (const pane of tabs) {
      next = addTab(next, after, pane)
      after = pane.id
    }
    return next
  }
  const zone = anchor.zone === 'center' ? 'right' : anchor.zone
  const direction: Direction = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical'
  return insertBeside(root, anchor.paneId, node, direction, zone === 'left' || zone === 'top')
}

export function moveTab(
  root: LayoutNode,
  sourceId: string,
  targetId: string,
  after: boolean,
): LayoutNode {
  const source = findPane(root, sourceId)
  if (sourceId === targetId || !source || !findPane(root, targetId)) return root
  const shared = tabsOfPane(root, sourceId)
  const sameStack = shared !== null && shared === tabsOfPane(root, targetId)
  const base = sameStack ? root : closePane(root, sourceId)
  const slotId = slotIdOf(base, targetId)
  if (!slotId) return root
  return replaceSlot(base, slotId, (slot) => {
    const panes = (slot.type === 'pane' ? [slot] : slot.children).filter((p) => p.id !== sourceId)
    panes.splice(panes.findIndex((p) => p.id === targetId) + (after ? 1 : 0), 0, source)
    return slot.type === 'pane'
      ? tabsOf(sourceId, ...panes)
      : { ...slot, children: panes, activeId: sourceId }
  })
}
