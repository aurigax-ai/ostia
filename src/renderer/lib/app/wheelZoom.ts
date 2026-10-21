import { ZOOM_DEFAULT } from '@shared/app/zoom'
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  type FontSurface,
  type SurfaceFont,
} from '@/stores/app/settingsModel'
import { useSettingsStore } from '@/stores/app/settingsStore'

const ZOOMABLE_SURFACES: readonly FontSurface[] = ['terminal', 'editor']

let ctrlHeld = false

export function startCtrlTracking(target: Window = window): () => void {
  const onKey = (e: KeyboardEvent): void => {
    ctrlHeld = e.key === 'Control' ? e.type === 'keydown' : e.ctrlKey
  }
  const onPointer = (e: MouseEvent): void => {
    ctrlHeld = e.ctrlKey
  }
  const onBlur = (): void => {
    ctrlHeld = false
  }
  target.addEventListener('keydown', onKey, true)
  target.addEventListener('keyup', onKey, true)
  target.addEventListener('pointerdown', onPointer, true)
  target.addEventListener('pointermove', onPointer, true)
  target.addEventListener('blur', onBlur)
  return () => {
    target.removeEventListener('keydown', onKey, true)
    target.removeEventListener('keyup', onKey, true)
    target.removeEventListener('pointerdown', onPointer, true)
    target.removeEventListener('pointermove', onPointer, true)
    target.removeEventListener('blur', onBlur)
    ctrlHeld = false
  }
}

function isPinch(e: Pick<WheelEvent, 'ctrlKey'>, mac: boolean): boolean {
  return !mac && e.ctrlKey && !ctrlHeld
}

export function zoomStep(
  e: Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'deltaY'>,
  mac: boolean,
): number {
  if (!(mac ? e.metaKey : e.ctrlKey && ctrlHeld) || e.deltaY === 0) return 0
  return e.deltaY < 0 ? 1 : -1
}

export function zoomFont(surface: FontSurface, step: number): void {
  if (step === 0) return
  const { appearance, setSurfaceFont } = useSettingsStore.getState()
  const font = appearance[surface]
  const size = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, font.size + step))
  if (size === font.size) return
  setSurfaceFont(surface, { size, baseSize: font.baseSize ?? font.size })
}

export function fontZoomPercent(font: SurfaceFont): number | null {
  if (font.baseSize === undefined || font.baseSize === font.size) return null
  return Math.round((font.size / font.baseSize) * 100)
}

export function activeFontZoom(appearance: Record<FontSurface, SurfaceFont>): number | null {
  for (const surface of ZOOMABLE_SURFACES) {
    const percent = fontZoomPercent(appearance[surface])
    if (percent !== null) return percent
  }
  return null
}

export function activeZoom(
  appearance: Record<FontSurface, SurfaceFont> & { zoom: number },
): number | null {
  if (appearance.zoom !== ZOOM_DEFAULT) return appearance.zoom
  return activeFontZoom(appearance)
}

export function resetFontZoom(): void {
  const { appearance, setSurfaceFont } = useSettingsStore.getState()
  for (const surface of ZOOMABLE_SURFACES) {
    const { baseSize } = appearance[surface]
    if (baseSize !== undefined) setSurfaceFont(surface, { size: baseSize })
  }
}

export function resetZoom(): void {
  useSettingsStore.getState().setZoom(ZOOM_DEFAULT)
  resetFontZoom()
}

export function attachWheelZoom(host: HTMLElement, surface: FontSurface, mac: boolean): () => void {
  const onWheel = (e: WheelEvent): void => {
    if (isPinch(e, mac)) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (!useSettingsStore.getState().behavior.wheelZoom) return
    const step = zoomStep(e, mac)
    if (step === 0) return
    e.preventDefault()
    e.stopPropagation()
    zoomFont(surface, step)
  }
  host.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return () => host.removeEventListener('wheel', onWheel, { capture: true })
}
