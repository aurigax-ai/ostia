import { type FontSurface, useSettingsStore } from '../stores/settingsStore'

export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 32

export function zoomStep(
  e: Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'deltaY'>,
  mac: boolean,
): number {
  if (!(mac ? e.metaKey : e.ctrlKey) || e.deltaY === 0) return 0
  return e.deltaY < 0 ? 1 : -1
}

export function zoomFont(surface: FontSurface, step: number): void {
  if (step === 0) return
  const { appearance, setSurfaceFont } = useSettingsStore.getState()
  const size = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, appearance[surface].size + step))
  if (size !== appearance[surface].size) setSurfaceFont(surface, { size })
}

export function attachWheelZoom(host: HTMLElement, surface: FontSurface, mac: boolean): () => void {
  const onWheel = (e: WheelEvent): void => {
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
