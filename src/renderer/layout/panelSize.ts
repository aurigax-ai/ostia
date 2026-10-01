import type { LayoutNode, PaneNode, SplitNode } from './types'

export const MIN_PANEL_FRACTION = 0.15
export const MAX_PANEL_FRACTION = 0.85

export interface PanelFraction {
  key: string
  fraction: number
}

export function panelKey(pane: PaneNode): string | null {
  if (pane.kind === 'extension' && pane.extensionId) return `extension:${pane.extensionId}`
  if (pane.kind === 'view' && pane.viewName) return `view:${pane.viewName}`
  if (pane.kind === 'chat') return 'chat'
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
