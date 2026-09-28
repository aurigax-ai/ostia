import type { Direction, DropZone, LayoutNode, PaneNode, SplitNode, SurfaceKind } from './types'

export type { DropZone } from './types'

let counter = 0

export function resetIds(): void {
  counter = 0
}

function genId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
}

export function adoptIds(node: LayoutNode): void {
  const n = Number(/-(\d+)$/.exec(node.id)?.[1])
  if (Number.isFinite(n)) counter = Math.max(counter, n)
  if (node.type === 'split') for (const child of node.children) adoptIds(child)
}

const SURFACE_TITLE: Record<SurfaceKind, string> = {
  terminal: 'zsh',
  editor: 'untitled',
  agent: 'claude',
  browser: 'localhost',
  kanban: 'Board',
  wiki: 'Wiki',
}

export function createPane(kind: SurfaceKind = 'terminal', title?: string, cwd?: string): PaneNode {
  return { type: 'pane', id: genId('pane'), title: title ?? SURFACE_TITLE[kind], kind, cwd }
}

function makeSplit(direction: Direction, children: LayoutNode[]): SplitNode {
  return { type: 'split', id: genId('split'), direction, children, sizes: children.map(() => 1) }
}

export function splitOf(direction: Direction, ...children: LayoutNode[]): SplitNode {
  return makeSplit(direction, children)
}

export function firstPaneId(node: LayoutNode): string {
  return node.type === 'pane' ? node.id : firstPaneId(node.children[0])
}

export function paneIds(node: LayoutNode): string[] {
  if (node.type === 'pane') return [node.id]
  return node.children.flatMap(paneIds)
}

export function allPanes(node: LayoutNode): PaneNode[] {
  if (node.type === 'pane') return [node]
  return node.children.flatMap(allPanes)
}

export function setPaneCwd(root: LayoutNode, paneId: string, cwd: string): LayoutNode {
  if (root.type === 'pane') return root.id === paneId && root.cwd !== cwd ? { ...root, cwd } : root
  return withChildren(root, (c) => setPaneCwd(c, paneId, cwd))
}

export function setPaneUrl(root: LayoutNode, paneId: string, url: string): LayoutNode {
  if (root.type === 'pane') return root.id === paneId && root.url !== url ? { ...root, url } : root
  return withChildren(root, (c) => setPaneUrl(c, paneId, url))
}

function withChildren(split: SplitNode, fn: (child: LayoutNode) => LayoutNode): SplitNode {
  const children = split.children.map(fn)
  return children.every((c, i) => c === split.children[i]) ? split : { ...split, children }
}

export function firstPaneOfKind(node: LayoutNode, kind: SurfaceKind): PaneNode | null {
  if (node.type === 'pane') return node.kind === kind ? node : null
  for (const child of node.children) {
    const found = firstPaneOfKind(child, kind)
    if (found) return found
  }
  return null
}

export function setPaneEditor(
  root: LayoutNode,
  paneId: string,
  title: string,
  filePath: string,
): LayoutNode {
  if (root.type === 'pane') {
    if (root.id !== paneId) return root
    const slash = filePath.lastIndexOf('/')
    const cwd = slash > 0 ? filePath.slice(0, slash) : '/'
    return { ...root, kind: 'editor', title, filePath, cwd }
  }
  return { ...root, children: root.children.map((c) => setPaneEditor(c, paneId, title, filePath)) }
}

function titleFromUrl(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

export function setPaneBrowser(root: LayoutNode, paneId: string, url: string): LayoutNode {
  if (root.type === 'pane') {
    if (root.id !== paneId) return root
    return { ...root, kind: 'browser', title: titleFromUrl(url), url }
  }
  return { ...root, children: root.children.map((c) => setPaneBrowser(c, paneId, url)) }
}

export function setPaneKind(root: LayoutNode, paneId: string, kind: SurfaceKind): LayoutNode {
  if (root.type === 'pane') {
    if (root.id !== paneId) return root
    return { ...root, kind, title: SURFACE_TITLE[kind] }
  }
  return { ...root, children: root.children.map((c) => setPaneKind(c, paneId, kind)) }
}

export function findPane(node: LayoutNode, id: string): PaneNode | null {
  if (node.type === 'pane') return node.id === id ? node : null
  for (const child of node.children) {
    const found = findPane(child, id)
    if (found) return found
  }
  return null
}

export function splitPane(
  root: LayoutNode,
  targetId: string,
  direction: Direction,
): { root: LayoutNode; newPaneId: string | null } {
  const newPane = createPane()
  let inserted = false

  const recur = (node: SplitNode): SplitNode => {
    const idx = node.children.findIndex((c) => c.type === 'pane' && c.id === targetId)
    if (idx !== -1) {
      inserted = true
      if (node.direction === direction) {
        const children = [...node.children]
        const sizes = [...node.sizes]
        const slot = sizes[idx] ?? 1
        children.splice(idx + 1, 0, newPane)
        sizes.splice(idx, 1, slot / 2, slot / 2)
        return { ...node, children, sizes }
      }
      const children = [...node.children]
      children[idx] = makeSplit(direction, [children[idx], newPane])
      return { ...node, children }
    }
    return {
      ...node,
      children: node.children.map((c) => (c.type === 'split' ? recur(c) : c)),
    }
  }

  if (root.type === 'pane') {
    if (root.id !== targetId) return { root, newPaneId: null }
    return { root: makeSplit(direction, [root, newPane]), newPaneId: newPane.id }
  }

  const newRoot = recur(root)
  return { root: newRoot, newPaneId: inserted ? newPane.id : null }
}

export function closePane(root: LayoutNode, targetId: string): LayoutNode {
  if (root.type === 'pane') return root

  const prune = (node: LayoutNode): LayoutNode | null => {
    if (node.type === 'pane') return node.id === targetId ? null : node
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
    return { ...node, children: kept, sizes }
  }

  return prune(root) ?? root
}

export function setSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (root.type === 'pane') return root
  const recur = (node: SplitNode): SplitNode => {
    if (node.id === splitId) return { ...node, sizes }
    return {
      ...node,
      children: node.children.map((c) => (c.type === 'split' ? recur(c) : c)),
    }
  }
  return recur(root)
}

function insertSibling(
  root: LayoutNode,
  targetId: string,
  node: LayoutNode,
  direction: Direction,
  before: boolean,
): LayoutNode {
  if (root.type === 'pane') {
    if (root.id !== targetId) return root
    return makeSplit(direction, before ? [node, root] : [root, node])
  }

  const recur = (split: SplitNode): SplitNode => {
    const idx = split.children.findIndex((c) => c.type === 'pane' && c.id === targetId)
    if (idx !== -1) {
      if (split.direction === direction) {
        const children = [...split.children]
        const sizes = [...split.sizes]
        const slot = sizes[idx] ?? 1
        children.splice(before ? idx : idx + 1, 0, node)
        sizes.splice(idx, 1, slot / 2, slot / 2)
        return { ...split, children, sizes }
      }
      const children = [...split.children]
      children[idx] = makeSplit(direction, before ? [node, children[idx]] : [children[idx], node])
      return { ...split, children }
    }
    return {
      ...split,
      children: split.children.map((c) => (c.type === 'split' ? recur(c) : c)),
    }
  }

  return recur(root)
}

function swapPanes(root: LayoutNode, aId: string, bId: string): LayoutNode {
  const a = findPane(root, aId)
  const b = findPane(root, bId)
  if (!a || !b) return root
  const replace = (node: LayoutNode): LayoutNode => {
    if (node.type === 'pane') {
      if (node.id === aId) return b
      if (node.id === bId) return a
      return node
    }
    return { ...node, children: node.children.map(replace) }
  }
  return replace(root)
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

  if (zone === 'center') return swapPanes(root, sourceId, targetId)

  const detached = closePane(root, sourceId)
  const direction: Direction = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical'
  const before = zone === 'left' || zone === 'top'
  return insertSibling(detached, targetId, source, direction, before)
}
