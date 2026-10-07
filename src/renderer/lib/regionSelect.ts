import type { Region } from '@shared/selection'

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export const MIN_REGION = 2

export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8] as const

const ZOOM_MIN = ZOOM_STEPS[0]
const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]
const PINCH_RATE = 0.01
const PINCH_DELTA_MAX = 50

export interface ZoomAnchor {
  content: Point
  client: Point
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function toContentPoint(
  client: Point,
  box: { left: number; top: number },
  scale: number,
): Point {
  const s = scale > 0 ? scale : 1
  return { x: (client.x - box.left) / s, y: (client.y - box.top) / s }
}

export function dragRegion(a: Point, b: Point, bounds: Size): Region | null {
  const left = clamp(Math.min(a.x, b.x), 0, bounds.width)
  const top = clamp(Math.min(a.y, b.y), 0, bounds.height)
  const right = clamp(Math.max(a.x, b.x), 0, bounds.width)
  const bottom = clamp(Math.max(a.y, b.y), 0, bounds.height)
  const x = Math.floor(left)
  const y = Math.floor(top)
  const width = Math.ceil(right) - x
  const height = Math.ceil(bottom) - y
  if (width < MIN_REGION || height < MIN_REGION) return null
  return { x, y, width, height }
}

export function scaleRegion(region: Region, factor: number): Region {
  return {
    x: Math.round(region.x * factor * 100) / 100,
    y: Math.round(region.y * factor * 100) / 100,
    width: Math.round(region.width * factor * 100) / 100,
    height: Math.round(region.height * factor * 100) / 100,
  }
}

export function pixelRect(region: Region, factor: number, bounds: Size): Region {
  const x = clamp(Math.floor(region.x * factor), 0, Math.max(0, bounds.width - 1))
  const y = clamp(Math.floor(region.y * factor), 0, Math.max(0, bounds.height - 1))
  const right = clamp(Math.ceil((region.x + region.width) * factor), x + 1, bounds.width)
  const bottom = clamp(Math.ceil((region.y + region.height) * factor), y + 1, bounds.height)
  return { x, y, width: right - x, height: bottom - y }
}

export function fitScale(content: Size, stage: Size, padding = 0): number {
  if (content.width <= 0 || content.height <= 0) return 1
  const w = stage.width - padding * 2
  const h = stage.height - padding * 2
  if (w <= 0 || h <= 0) return 1
  return Math.min(1, w / content.width, h / content.height)
}

export function fitWidthScale(content: Size, stage: Size, padding = 0): number {
  const w = stage.width - padding * 2
  if (content.width <= 0 || w <= 0) return 1
  return w / content.width
}

export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((z) => z > current + 1e-6) ?? ZOOM_STEPS.at(-1) ?? 1
  const lower = [...ZOOM_STEPS].reverse().find((z) => z < current - 1e-6)
  return lower ?? ZOOM_STEPS[0]
}

export function zoomPercent(scale: number): number {
  return Math.round(scale * 100)
}

export function pinchZoom(scale: number, deltaY: number): number {
  const delta = clamp(deltaY, -PINCH_DELTA_MAX, PINCH_DELTA_MAX)
  return clamp(scale * Math.exp(-delta * PINCH_RATE), ZOOM_MIN, ZOOM_MAX)
}

export function anchoredScroll(
  scroll: Point,
  anchor: ZoomAnchor,
  box: { left: number; top: number },
  scale: number,
): Point {
  return {
    x: scroll.x + box.left + anchor.content.x * scale - anchor.client.x,
    y: scroll.y + box.top + anchor.content.y * scale - anchor.client.y,
  }
}
