export const ZOOM_MIN = 80
export const ZOOM_MAX = 150
export const ZOOM_STEP = 10
export const ZOOM_DEFAULT = 100

export function clampZoom(percent: unknown): number {
  const n =
    typeof percent === 'number' && Number.isFinite(percent) ? Math.round(percent) : ZOOM_DEFAULT
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n))
}

export function stepZoom(current: number, direction: 1 | -1): number {
  return clampZoom(Math.round(current / ZOOM_STEP) * ZOOM_STEP + direction * ZOOM_STEP)
}

export function zoomFactor(percent: unknown): number {
  return clampZoom(percent) / 100
}
