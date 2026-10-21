export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface ZoomAnchor {
  content: Point
  client: Point
}

export type Zoom = number | 'fit'

export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8] as const
export const ZOOM_MENU_PERCENTS = [50, 75, 100, 125, 150, 200, 300, 400] as const
const FIT_PADDING = 16

const ZOOM_MIN = ZOOM_STEPS[0]
const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]
const PINCH_RATE = 0.01
const PINCH_DELTA_MAX = 50
const STEP_EPSILON = 1e-6

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function fitScale(content: Size, stage: Size, padding: number): number {
  if (content.width <= 0 || content.height <= 0) return 1
  const width = stage.width - padding * 2
  const height = stage.height - padding * 2
  if (width <= 0 || height <= 0) return 1
  return Math.min(1, width / content.width, height / content.height)
}

export function scaleOf(zoom: Zoom, content: Size, stage: Size): number {
  return zoom === 'fit' ? fitScale(content, stage, FIT_PADDING) : zoom
}

export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > current + STEP_EPSILON) ?? ZOOM_MAX
  const lower = [...ZOOM_STEPS].reverse().find((step) => step < current - STEP_EPSILON)
  return lower ?? ZOOM_MIN
}

export function pinchZoom(scale: number, deltaY: number): number {
  const delta = clamp(deltaY, -PINCH_DELTA_MAX, PINCH_DELTA_MAX)
  return clamp(scale * Math.exp(-delta * PINCH_RATE), ZOOM_MIN, ZOOM_MAX)
}

export function zoomPercent(scale: number): number {
  return Math.round(scale * 100)
}

export function menuPercent(scale: number): number | null {
  const percent = zoomPercent(scale)
  return (ZOOM_MENU_PERCENTS as readonly number[]).includes(percent) ? percent : null
}

export function formatPercent(percent: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
    percent / 100,
  )
}

export function toContentPoint(
  client: Point,
  box: { left: number; top: number },
  scale: number,
): Point {
  const factor = scale > 0 ? scale : 1
  return { x: (client.x - box.left) / factor, y: (client.y - box.top) / factor }
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
