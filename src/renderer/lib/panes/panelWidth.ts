import { readPref, writePref } from '@/lib/app/localPrefs'

export interface PanelWidthSpec {
  storageKey: string
  cssVar: string
  defaultWidth: number
  minWidth: number
  maxWidth: number
  maxViewportFraction: number
  collapseBelow?: number
}

export const RAIL_WIDTH: PanelWidthSpec = {
  storageKey: 'railWidth',
  cssVar: '--rail-w',
  defaultWidth: 240,
  minWidth: 180,
  maxWidth: 480,
  maxViewportFraction: 0.4,
  collapseBelow: 90,
}

export const FILES_WIDTH: PanelWidthSpec = {
  storageKey: 'filesWidth',
  cssVar: '--files-w',
  defaultWidth: 260,
  minWidth: 180,
  maxWidth: 720,
  maxViewportFraction: 0.5,
}

export const PANEL_KEY_STEP = 16

export function panelMaxWidth(spec: PanelWidthSpec, viewportWidth: number): number {
  const byViewport = Math.floor(viewportWidth * spec.maxViewportFraction)
  return Math.max(spec.minWidth, Math.min(spec.maxWidth, byViewport))
}

export function clampPanelWidth(
  spec: PanelWidthSpec,
  width: number,
  viewportWidth: number,
): number {
  return Math.round(Math.min(panelMaxWidth(spec, viewportWidth), Math.max(spec.minWidth, width)))
}

export interface PanelDragResult {
  collapsed: boolean
  width: number
}

export function panelDragResult(
  spec: PanelWidthSpec,
  startWidth: number,
  dx: number,
  viewportWidth: number,
): PanelDragResult {
  const raw = startWidth + dx
  if (spec.collapseBelow !== undefined && raw < spec.collapseBelow) {
    return { collapsed: true, width: startWidth }
  }
  return { collapsed: false, width: clampPanelWidth(spec, raw, viewportWidth) }
}

export function panelKeyWidth(
  spec: PanelWidthSpec,
  key: string,
  width: number,
  viewportWidth: number,
): number | null {
  switch (key) {
    case 'ArrowLeft':
      return clampPanelWidth(spec, width - PANEL_KEY_STEP, viewportWidth)
    case 'ArrowRight':
      return clampPanelWidth(spec, width + PANEL_KEY_STEP, viewportWidth)
    case 'Home':
      return spec.minWidth
    case 'End':
      return panelMaxWidth(spec, viewportWidth)
    default:
      return null
  }
}

export function storedPanelWidth(spec: PanelWidthSpec): number {
  const value = readPref(spec.storageKey)
  const inRange =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= spec.minWidth &&
    value <= spec.maxWidth
  return inRange ? Math.round(value) : spec.defaultWidth
}

export function storePanelWidth(spec: PanelWidthSpec, width: number): void {
  writePref(spec.storageKey, Math.round(width))
}

export function applyPanelWidth(spec: PanelWidthSpec, width: number): void {
  document.documentElement.style.setProperty(spec.cssVar, `${width}px`)
}

export function applyStoredPanelWidths(): void {
  for (const spec of [RAIL_WIDTH, FILES_WIDTH]) {
    applyPanelWidth(spec, clampPanelWidth(spec, storedPanelWidth(spec), window.innerWidth))
  }
}
