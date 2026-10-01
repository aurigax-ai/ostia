export const RAIL_WIDTH_KEY = 'railWidth'
export const RAIL_DEFAULT_WIDTH = 240
export const RAIL_MIN_WIDTH = 180
export const RAIL_MAX_WIDTH = 480
export const RAIL_MAX_VIEWPORT_FRACTION = 0.4
export const RAIL_KEY_STEP = 16
export const RAIL_COLLAPSE_BELOW = RAIL_MIN_WIDTH / 2

export function railMaxWidth(viewportWidth: number): number {
  const byViewport = Math.floor(viewportWidth * RAIL_MAX_VIEWPORT_FRACTION)
  return Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, byViewport))
}

export function clampRailWidth(width: number, viewportWidth: number): number {
  return Math.round(Math.min(railMaxWidth(viewportWidth), Math.max(RAIL_MIN_WIDTH, width)))
}

export interface RailDragResult {
  collapsed: boolean
  width: number
}

export function railDragResult(
  startWidth: number,
  dx: number,
  viewportWidth: number,
): RailDragResult {
  const raw = startWidth + dx
  if (raw < RAIL_COLLAPSE_BELOW) return { collapsed: true, width: startWidth }
  return { collapsed: false, width: clampRailWidth(raw, viewportWidth) }
}

export function railKeyWidth(key: string, width: number, viewportWidth: number): number | null {
  switch (key) {
    case 'ArrowLeft':
      return clampRailWidth(width - RAIL_KEY_STEP, viewportWidth)
    case 'ArrowRight':
      return clampRailWidth(width + RAIL_KEY_STEP, viewportWidth)
    case 'Home':
      return RAIL_MIN_WIDTH
    case 'End':
      return railMaxWidth(viewportWidth)
    default:
      return null
  }
}

function inStoredRange(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= RAIL_MIN_WIDTH &&
    value <= RAIL_MAX_WIDTH
  )
}

export function storedRailWidth(): number {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(RAIL_WIDTH_KEY) ?? 'null')
    return inStoredRange(value) ? Math.round(value) : RAIL_DEFAULT_WIDTH
  } catch {
    return RAIL_DEFAULT_WIDTH
  }
}

export function storeRailWidth(width: number): void {
  try {
    window.localStorage.setItem(RAIL_WIDTH_KEY, JSON.stringify(Math.round(width)))
  } catch {}
}

export function applyRailWidth(width: number): void {
  document.documentElement.style.setProperty('--rail-w', `${width}px`)
}

export function applyStoredRailWidth(): void {
  applyRailWidth(clampRailWidth(storedRailWidth(), window.innerWidth))
}
