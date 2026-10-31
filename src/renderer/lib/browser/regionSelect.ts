import type { Region } from '@shared/browser/selection'
import { clamp } from 'es-toolkit'

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

const MIN_REGION = 2

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
