import { findPane, paneIds, shownTab } from './tree'
import type { LayoutNode } from './types'

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

function topLeftShownPane(node: LayoutNode): string {
  if (node.type === 'pane') return node.id
  return topLeftShownPane(node.type === 'tabs' ? shownTab(node) : node.children[0])
}

export function keyboardPaneId(layout: {
  root: LayoutNode
  activePaneId: string
  zoomedPaneId: string | null
}): string {
  const { root, activePaneId, zoomedPaneId } = layout
  if (zoomedPaneId && findPane(root, zoomedPaneId)) return zoomedPaneId
  if (findPane(root, activePaneId)) return activePaneId
  return topLeftShownPane(root)
}
