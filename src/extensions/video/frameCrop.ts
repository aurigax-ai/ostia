export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

const CROP_MIN_PIXELS = 4

export function fitBox(
  container: { width: number; height: number },
  media: { width: number; height: number },
): Box {
  if (media.width <= 0 || media.height <= 0 || container.width <= 0 || container.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const scale = Math.min(container.width / media.width, container.height / media.height)
  const width = media.width * scale
  const height = media.height * scale
  return { x: (container.width - width) / 2, y: (container.height - height) / 2, width, height }
}

export function dragBox(from: Point, to: Point, within: Box): Box | null {
  const left = Math.min(Math.max(Math.min(from.x, to.x), within.x), within.x + within.width)
  const right = Math.min(Math.max(Math.max(from.x, to.x), within.x), within.x + within.width)
  const top = Math.min(Math.max(Math.min(from.y, to.y), within.y), within.y + within.height)
  const bottom = Math.min(Math.max(Math.max(from.y, to.y), within.y), within.y + within.height)
  if (right - left < CROP_MIN_PIXELS || bottom - top < CROP_MIN_PIXELS) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function nativeRegion(
  selection: Box,
  shown: Box,
  media: { width: number; height: number },
): Box | null {
  if (shown.width <= 0 || shown.height <= 0) return null
  const scaleX = media.width / shown.width
  const scaleY = media.height / shown.height
  const x = Math.min(Math.max(Math.round((selection.x - shown.x) * scaleX), 0), media.width - 1)
  const y = Math.min(Math.max(Math.round((selection.y - shown.y) * scaleY), 0), media.height - 1)
  const right = Math.min(
    Math.max(Math.round((selection.x + selection.width - shown.x) * scaleX), x + 1),
    media.width,
  )
  const bottom = Math.min(
    Math.max(Math.round((selection.y + selection.height - shown.y) * scaleY), y + 1),
    media.height,
  )
  return { x, y, width: right - x, height: bottom - y }
}
