export interface Size {
  width: number
  height: number
}

export type ZoomMode = 'fit-width' | 'fit-page' | number

export const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const
export const ZOOM_MIN = 0.1
export const ZOOM_MAX = 8
export const PAGE_GAP = 12
const STAGE_PADDING = 16
export const MAX_CANVAS_PIXELS = 16_777_216

const PINCH_RATE = 0.01
const PINCH_DELTA_MAX = 50
const SAME_SCALE = 0.0005
const VISIBLE_ENOUGH = 0.5

export function clampScale(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
}

export function pinchScale(scale: number, deltaY: number): number {
  const delta = Math.min(PINCH_DELTA_MAX, Math.max(-PINCH_DELTA_MAX, deltaY))
  return clampScale(scale * Math.exp(-delta * PINCH_RATE))
}

export function stepScale(scale: number, direction: 1 | -1): number {
  const next =
    direction === 1
      ? ZOOM_PRESETS.find((preset) => preset > scale + SAME_SCALE)
      : [...ZOOM_PRESETS].reverse().find((preset) => preset < scale - SAME_SCALE)
  return next ?? (direction === 1 ? ZOOM_MAX : ZOOM_MIN)
}

export function turnedSize(size: Size, rotation: number): Size {
  return rotation % 180 === 0 ? size : { width: size.height, height: size.width }
}

export function rotateBy(rotation: number, delta: number): number {
  return (((rotation + delta) % 360) + 360) % 360
}

export function fitWidthScale(page: Size, stage: Size): number {
  const width = stage.width - STAGE_PADDING * 2
  return page.width > 0 && width > 0 ? clampScale(width / page.width) : 1
}

export function fitPageScale(page: Size, stage: Size): number {
  const height = stage.height - STAGE_PADDING * 2
  if (page.height <= 0 || height <= 0) return fitWidthScale(page, stage)
  return clampScale(Math.min(fitWidthScale(page, stage), height / page.height))
}

export function resolveScale(mode: ZoomMode, page: Size, stage: Size): number {
  if (mode === 'fit-width') return fitWidthScale(page, stage)
  if (mode === 'fit-page') return fitPageScale(page, stage)
  return clampScale(mode)
}

export function zoomText(scale: number): string {
  return `${Math.round(scale * 100)}%`
}

function presetId(percent: number): string {
  return `zoom-${percent}`
}

export function modeChoice(mode: ZoomMode): string | null {
  if (mode === 'fit-width' || mode === 'fit-page') return mode
  const preset = ZOOM_PRESETS.find((value) => Math.abs(value - mode) < SAME_SCALE)
  return preset === undefined ? null : presetId(Math.round(preset * 100))
}

export function modeOfChoice(id: string): ZoomMode | null {
  if (id === 'fit-width' || id === 'fit-page') return id
  if (id === 'actual-size') return 1
  const preset = ZOOM_PRESETS.find((value) => presetId(Math.round(value * 100)) === id)
  return preset ?? null
}

export function renderRatio(size: Size, devicePixelRatio: number, maxPixels: number): number {
  const wanted = Math.max(1, devicePixelRatio)
  const pixels = size.width * size.height * wanted * wanted
  return pixels > maxPixels
    ? Math.max(0.1, Math.sqrt(maxPixels / (size.width * size.height)))
    : wanted
}

export interface PageRows {
  count: number
  top: (index: number) => number
  height: (index: number) => number
}

export interface ScrollView {
  scrollTop: number
  height: number
  scrollHeight: number
}

function firstEndingBelow(rows: PageRows, line: number): number {
  let low = 0
  let high = rows.count - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (rows.top(middle) + rows.height(middle) > line) high = middle
    else low = middle + 1
  }
  return low
}

export function currentPage(rows: PageRows, view: ScrollView): number {
  if (rows.count === 0) return 0
  const bottom = view.scrollTop + view.height
  if (view.scrollTop > 0 && bottom >= view.scrollHeight - 1) return rows.count
  let best = firstEndingBelow(rows, view.scrollTop)
  let bestVisible = -1
  for (let index = best; index < rows.count && rows.top(index) < bottom; index++) {
    const top = Math.max(rows.top(index), view.scrollTop)
    const end = Math.min(rows.top(index) + rows.height(index), bottom)
    const visible = end - top
    if (visible > bestVisible) {
      bestVisible = visible
      best = index
    }
    if (visible >= view.height * VISIBLE_ENOUGH) break
  }
  return best + 1
}
