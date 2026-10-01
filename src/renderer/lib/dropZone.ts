import type { ScreenPoint } from '@shared/types'
import type { DropZone } from '../layout/types'

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

const EDGE_FRACTION = 0.28
const EDGE_MIN_PX = 48

function band(size: number): number {
  return Math.min(Math.max(size * EDGE_FRACTION, EDGE_MIN_PX), size / 3)
}

export function dropZoneAt(rect: Rect, x: number, y: number): DropZone {
  if (rect.width <= 0 || rect.height <= 0) return 'center'
  const bx = band(rect.width)
  const by = band(rect.height)
  const dx = Math.min(Math.max(x - rect.left, 0), rect.width)
  const dy = Math.min(Math.max(y - rect.top, 0), rect.height)
  const reach: [DropZone, number][] = [
    ['left', dx / bx],
    ['right', (rect.width - dx) / bx],
    ['top', dy / by],
    ['bottom', (rect.height - dy) / by],
  ]
  let best: [DropZone, number] = ['center', 1]
  for (const candidate of reach) {
    if (candidate[1] < best[1]) best = candidate
  }
  return best[0]
}

export interface DropTargetSlot {
  tabIds: readonly string[]
  shownId: string
}

export interface PaneDropTarget {
  targetId: string
  zone: DropZone
}

export function paneDropTarget(
  slot: DropTargetSlot,
  sourceId: string | null,
  zone: DropZone,
): PaneDropTarget | null {
  if (!sourceId || !slot.tabIds.includes(sourceId)) return { targetId: slot.shownId, zone }
  if (zone === 'center') return null
  const other = slot.tabIds.find((id) => id !== sourceId)
  return other ? { targetId: other, zone } : null
}

export interface TabDrop {
  targetId: string
  after: boolean
}

export function tabDropTarget(
  tabIds: readonly string[],
  sourceId: string | null,
  hovered: TabDrop | null,
): TabDrop | null {
  const target =
    hovered ?? (tabIds.length > 0 ? { targetId: tabIds[tabIds.length - 1], after: true } : null)
  if (!target || target.targetId === sourceId) return null
  if (sourceId && tabIds.includes(sourceId)) {
    const from = tabIds.indexOf(sourceId)
    const to = tabIds.indexOf(target.targetId) + (target.after ? 1 : 0)
    if (to === from || to === from + 1) return null
  }
  return target
}

export interface DragEnd {
  dropEffect: string
  point: ScreenPoint
  origin: ScreenPoint
}

export interface Viewport {
  width: number
  height: number
}

export function endedOutside(end: DragEnd, viewport: Viewport): boolean {
  if (end.dropEffect !== 'none') return false
  const x = end.point.x - end.origin.x
  const y = end.point.y - end.origin.y
  return x < 0 || y < 0 || x >= viewport.width || y >= viewport.height
}
