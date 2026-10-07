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
    const children = node.children.map((c) => mapPanes(c, fn) as TabNode)
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
  return mapPane(root, paneId, (p) => {
    if (p.resumeFolderMissing === cwd) {
      const { resumeFolderMissing: _missing, ...rest } = p
      return { ...rest, cwd }
    }
    return p.cwd === cwd ? p : { ...p, cwd }
  })
}

export function settleSpawnDir(root: LayoutNode, paneId: string, missing: boolean): LayoutNode {
  return mapPane(root, paneId, (p) => {
    if (p.spawnDir === undefined) return p
    const { spawnDir, ...rest } = p
    return missing ? { ...rest, resumeFolderMissing: spawnDir } : rest
  })
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
  return mapPane(root, paneId, (p) => {
    if (
      p.resume?.agent === resume.agent &&
      p.resume.id === resume.id &&
      p.resume.cwd === resume.cwd
    )
      return p
    const { resumeFolderMissing: _missing, ...rest } = p
    return { ...rest, resume }
  })
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
    return awake.resume?.cwd ? { ...awake, spawnDir: awake.resume.cwd } : awake
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

export function movedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to
  return path.startsWith(`${from}/`) ? to + path.slice(from.length) : null
}

export function followMovedFile(root: LayoutNode, from: string, to: string): LayoutNode {
  return mapPanes(root, (p) => {
    if (p.kind !== 'editor' || !p.filePath) return p
    const next = movedPath(p.filePath, from, to)
    if (next === null) return p
    return setPaneEditor(p, p.id, next.slice(next.lastIndexOf('/') + 1), next) as PaneNode
  })
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

function untab(tab: LayoutNode): LayoutNode {
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
  const at = tabIndex(tabs, paneId)
  const next = (at + step + tabs.children.length) % tabs.children.length
  return firstPaneId(tabs.children[next])
}

export function tabNeighbor(root: LayoutNode, paneId: string, step: 1 | -1): string | null {
  const tabs = tabsOfPane(root, paneId)
  if (!tabs) return null
  return tabs.children[tabIndex(tabs, paneId) + step]?.id ?? null
}

function tabIndex(tabs: TabsNode, paneId: string): number {
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

export function tabOfPane(root: LayoutNode, paneId: string): TabNode | null {
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

export function nameSplitTabOf(root: LayoutNode, paneId: string, name: string): LayoutNode {
  const tab = splitTabOfPane(root, paneId)
  const tabs = tabsOfPane(root, paneId)
  if (!tab || !tabs || tab.name !== undefined) return root
  const children = tabs.children.map((c) => (c === tab ? { ...tab, name } : c))
  return replaceSlot(root, tabs.id, () => ({ ...tabs, children }))
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
  return tabs
    ? tabIndex(tabs, tabs.activeId) === tabIndex(tabs, paneId)
    : findPane(root, paneId) !== null
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
    const [first, ...rest] = slotRects(shownTab(node), x, y, w, h)
    const placed = new Set([first, ...rest].flatMap((r) => r.shownIds))
    const hidden = paneIds(node).filter((id) => !placed.has(id))
    return [{ ...first, shownIds: [...first.shownIds, ...hidden] }, ...rest]
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

function placeBeside(
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
  const recur = (node: LayoutNode): LayoutNode => {
    if (node.type === 'pane') return node
    if (node.type === 'split' && node.id === splitId) return { ...node, sizes }
    const children = node.children.map(recur)
    if (children.every((c, i) => c === node.children[i])) return node
    return node.type === 'tabs'
      ? { ...node, children: children as TabNode[] }
      : { ...node, children }
  }
  return recur(root)
}

export function mergeLayouts(target: LayoutNode, source: LayoutNode): LayoutNode {
  return makeSplit('horizontal', [target, source])
}

function tabSource(root: LayoutNode, id: string): TabNode | null {
  return findPane(root, id) ?? findSplitTab(root, id)
}

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
  if (!anchor) return makeSplit('horizontal', [root, node])
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
