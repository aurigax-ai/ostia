export const SPLIT_KEY_STEP = 16
export const SPLIT_PAGE_STEP = 64

export interface SplitBounds {
  min: number
  max: number
  collapsed: boolean
}

export function splitBounds(total: number, minFirst: number, minSecond: number): SplitBounds {
  const max = Math.max(0, total - minSecond)
  return { min: Math.min(minFirst, max), max, collapsed: total < minFirst + minSecond }
}

export function clampPosition(position: number, bounds: SplitBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, position))
}

export function fractionOf(position: number, total: number, bounds: SplitBounds): number {
  if (total <= 0) return 0
  return clampPosition(position, bounds) / total
}

export function keyPosition(key: string, position: number, bounds: SplitBounds): number | null {
  const moves: Record<string, number> = {
    ArrowUp: position - SPLIT_KEY_STEP,
    ArrowDown: position + SPLIT_KEY_STEP,
    PageUp: position - SPLIT_PAGE_STEP,
    PageDown: position + SPLIT_PAGE_STEP,
    Home: bounds.min,
    End: bounds.max,
  }
  return key in moves ? clampPosition(moves[key], bounds) : null
}

export function percentOf(position: number, total: number): number {
  return total > 0 ? Math.round((position / total) * 100) : 0
}

export function splitBasis(fraction: number, minFirst: number, minSecond: number): string {
  return `clamp(${minFirst}px, ${fraction * 100}%, calc(100% - ${minSecond}px))`
}
