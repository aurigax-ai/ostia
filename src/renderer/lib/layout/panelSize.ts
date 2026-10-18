import { isStrip } from './collapse'
import type { LayoutNode, PaneNode, SplitNode, TabNode } from './types'

const MIN_PANEL_FRACTION = 0.15
const MAX_PANEL_FRACTION = 0.85

export interface PanelFraction {
  key: string
  fraction: number
}

export function panelKey(pane: PaneNode): string | null {
  if (pane.kind === 'extension' && pane.extensionId) return `extension:${pane.extensionId}`
  if (pane.kind === 'view' && pane.viewName) return `view:${pane.viewName}`
  if (pane.kind === 'chat') return 'chat'
  if (pane.kind === 'git') return 'git'
  return null
}

export function clampFraction(fraction: number): number | null {
  if (!Number.isFinite(fraction) || fraction <= 0) return null
  return Math.min(MAX_PANEL_FRACTION, Math.max(MIN_PANEL_FRACTION, fraction))
}

export function panelFractions(split: SplitNode, sizes: number[]): PanelFraction[] {
  if (sizes.length !== split.children.length) return []
  const total = sizes.reduce((sum, n) => sum + n, 0)
  if (!(total > 0)) return []
  const found: PanelFraction[] = []
  split.children.forEach((child, i) => {
    if (child.type !== 'pane') return
    const key = panelKey(child)
    const fraction = clampFraction(sizes[i] / total)
    if (key && fraction !== null) found.push({ key, fraction })
  })
  return found
}

function parentSplitOf(node: LayoutNode, paneId: string): SplitNode | null {
  if (node.type !== 'split') return null
  if (node.children.some((c) => c.type === 'pane' && c.id === paneId)) return node
  for (const child of node.children) {
    const found = parentSplitOf(child, paneId)
    if (found) return found
  }
  return null
}

function replaceSplit(node: LayoutNode, next: SplitNode): LayoutNode {
  if (node.type !== 'split') return node
  if (node.id === next.id) return next
  const children = node.children.map((c) => replaceSplit(c, next))
  return children.every((c, i) => c === node.children[i]) ? node : { ...node, children }
}

export function sizePanel(root: LayoutNode, paneId: string, fraction: number): LayoutNode {
  const clamped = clampFraction(fraction)
  const split = parentSplitOf(root, paneId)
  if (clamped === null || !split || split.children.length < 2) return root
  const idx = split.children.findIndex((c) => c.id === paneId)
  const neighbor = idx > 0 ? idx - 1 : idx + 1
  const total = split.sizes.reduce((sum, n) => sum + n, 0)
  const combined = (split.sizes[idx] ?? 0) + (split.sizes[neighbor] ?? 0)
  if (!(total > 0) || !(combined > 0)) return root
  const panel = Math.min(clamped * total, combined * MAX_PANEL_FRACTION)
  const sizes = [...split.sizes]
  sizes[idx] = panel
  sizes[neighbor] = combined - panel
  if (sizes.every((n, i) => n === split.sizes[i])) return root
  return replaceSplit(root, { ...split, sizes })
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

export function setSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  const recur = (node: LayoutNode): LayoutNode => {
    if (node.type === 'pane') return node
    if (node.type === 'split' && node.id === splitId) {
      const kept = sizes.map((n, i) => {
        const child = node.children[i]
        return child && isStrip(child) ? (node.sizes[i] ?? n) : n
      })
      const same = node.sizes.length === kept.length && node.sizes.every((n, i) => n === kept[i])
      return same ? node : { ...node, sizes: kept }
    }
    const children = node.children.map(recur)
    if (children.every((c, i) => c === node.children[i])) return node
    return node.type === 'tabs'
      ? { ...node, children: children as TabNode[] }
      : { ...node, children }
  }
  return recur(root)
}
