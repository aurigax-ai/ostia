import type { Box } from './frameCrop'

const CAPTURE_LONG_SIDE_MAX = 4096
export const CAPTURE_SHRINK = 0.5
export const CAPTURE_ATTEMPTS = 4

export interface Size {
  width: number
  height: number
}

export function captureFactor(size: Size, longSideMax: number = CAPTURE_LONG_SIDE_MAX): number {
  const longSide = Math.max(size.width, size.height)
  return longSide > longSideMax ? longSideMax / longSide : 1
}

export function scaledSize(size: Size, factor: number): Size {
  return {
    width: Math.max(1, Math.round(size.width * factor)),
    height: Math.max(1, Math.round(size.height * factor)),
  }
}

export function scaledRegion(region: Box, factor: number, within: Size): Box {
  const x = Math.min(Math.round(region.x * factor), within.width - 1)
  const y = Math.min(Math.round(region.y * factor), within.height - 1)
  const size = scaledSize(region, factor)
  return {
    x,
    y,
    width: Math.min(size.width, within.width - x),
    height: Math.min(size.height, within.height - y),
  }
}
