import type { ViewerRect } from '@aurigax-ai/ostia-extension-sdk/contract/viewerSelection'
import type { Point, Size } from './imageZoom'

const MIN_REGION = 2

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function dragRegion(a: Point, b: Point, bounds: Size): ViewerRect | null {
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

export function cropRect(region: ViewerRect | null, natural: Size): ViewerRect {
  return region ?? { x: 0, y: 0, width: natural.width, height: natural.height }
}

export function pageRect(
  region: ViewerRect | null,
  natural: Size,
  box: { left: number; top: number },
  scale: number,
  viewport: Size,
): ViewerRect | null {
  const crop = cropRect(region, natural)
  const left = clamp(box.left + crop.x * scale, 0, viewport.width)
  const top = clamp(box.top + crop.y * scale, 0, viewport.height)
  const right = clamp(box.left + (crop.x + crop.width) * scale, 0, viewport.width)
  const bottom = clamp(box.top + (crop.y + crop.height) * scale, 0, viewport.height)
  if (right - left < 1 || bottom - top < 1) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}
