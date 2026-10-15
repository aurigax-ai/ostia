import { reducedMotionNow } from '@/lib/app/motion'
import { useSettingsStore } from '@/stores/app/settingsStore'
import type { OstiaTerminal } from './ostiaTerminal'

export const SMOOTH_SCROLL_MS = 125

const WHEEL_NOTCH = 120

export type WheelSample = Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'> & {
  wheelDeltaY?: number
}

export function isPhysicalWheel(e: WheelSample): boolean {
  if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return true
  if (e.deltaX !== 0 || e.deltaY === 0) return false
  const legacy = e.wheelDeltaY
  return typeof legacy === 'number' && legacy !== 0 && Math.abs(legacy) % WHEEL_NOTCH === 0
}

export function smoothScrollDuration(input: {
  enabled: boolean
  reducedMotion: boolean
  physicalWheel: boolean
}): number {
  return input.enabled && !input.reducedMotion && input.physicalWheel ? SMOOTH_SCROLL_MS : 0
}

export function attachSmoothScroll(
  host: HTMLElement,
  term: Pick<OstiaTerminal, 'options'>,
): () => void {
  const onWheel = (e: WheelEvent): void => {
    term.options.smoothScrollDuration = smoothScrollDuration({
      enabled: useSettingsStore.getState().behavior.smoothScrolling,
      reducedMotion: reducedMotionNow(),
      physicalWheel: isPhysicalWheel(e as WheelSample),
    })
  }
  host.addEventListener('wheel', onWheel, { capture: true, passive: true })
  return () => host.removeEventListener('wheel', onWheel, { capture: true })
}
