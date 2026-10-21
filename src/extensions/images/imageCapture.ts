import type { Size } from './imageZoom'

export const CAPTURE_LONG_SIDE_MAX = 4096
const CAPTURE_SHRINK = 0.5
export const CAPTURE_ATTEMPTS = 6

export function captureScale(region: Size): number {
  const longSide = Math.max(region.width, region.height)
  return longSide > CAPTURE_LONG_SIDE_MAX ? CAPTURE_LONG_SIDE_MAX / longSide : 1
}

export function scaledSize(region: Size, scale: number): Size {
  return {
    width: Math.max(1, Math.round(region.width * scale)),
    height: Math.max(1, Math.round(region.height * scale)),
  }
}

export async function encodeWithin<T extends { size: number }>(
  region: Size,
  maxBytes: number,
  encode: (output: Size) => Promise<T | null>,
): Promise<T | null> {
  let scale = captureScale(region)
  for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt++) {
    const encoded = await encode(scaledSize(region, scale))
    if (encoded && encoded.size <= maxBytes) return encoded
    scale *= CAPTURE_SHRINK
  }
  return null
}
