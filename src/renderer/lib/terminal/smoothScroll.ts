import { reducedMotionNow } from '@/lib/app/motion'
import { zoomStep } from '@/lib/app/wheelZoom'
import { useSettingsStore } from '@/stores/app/settingsStore'
import type { OstiaTerminal } from './ostiaTerminal'
import { wheelRoute } from './wheelReports'

export const SMOOTH_SCROLL_MS = 125

const WHEEL_NOTCH = 120
const PIXELS_PER_LINE = 40
const HISTORY = 5

export type WheelSample = Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'> & {
  wheelDeltaX?: number
  wheelDeltaY?: number
}

export interface WheelClassifier {
  accept: (sample: WheelSample) => void
  isPhysicalWheel: () => boolean
}

interface WheelDelta {
  x: number
  y: number
}

function normalizedAxis(legacy: number | undefined, delta: number, mode: number): number {
  if (legacy !== undefined) return legacy / WHEEL_NOTCH
  return mode === WheelEvent.DOM_DELTA_LINE ? -delta : -delta / PIXELS_PER_LINE
}

function normalizedDelta(e: WheelSample): WheelDelta {
  return {
    x: normalizedAxis(e.wheelDeltaX, e.deltaX, e.deltaMode),
    y: normalizedAxis(e.wheelDeltaY, e.deltaY, e.deltaMode),
  }
}

function isAlmostInt(value: number): boolean {
  return Math.abs(Math.round(value) - value) < 0.01
}

function sameModulo(a: number, b: number): boolean {
  const min = Math.max(Math.min(Math.abs(a), Math.abs(b)), 1)
  return Math.max(Math.abs(a), Math.abs(b)) % min === 0
}

function trackpadScore(item: WheelDelta, previous: WheelDelta | null): number {
  if (Math.abs(item.x) > 0 && Math.abs(item.y) > 0) return 1
  let score = 0.5
  if (!isAlmostInt(item.x) || !isAlmostInt(item.y)) score += 0.25
  if (previous && sameModulo(item.x, previous.x) && sameModulo(item.y, previous.y)) score -= 0.5
  return Math.min(Math.max(score, 0), 1)
}

export function createWheelClassifier(): WheelClassifier {
  const scores: number[] = []
  let previous: WheelDelta | null = null
  return {
    accept: (sample) => {
      const item = normalizedDelta(sample)
      scores.push(trackpadScore(item, previous))
      if (scores.length > HISTORY) scores.shift()
      previous = item
    },
    isPhysicalWheel: () => {
      if (scores.length === 0) return false
      let remaining = 1
      let total = 0
      for (let i = scores.length - 1, step = 1; i >= 0; i--, step++) {
        const influence = i === 0 ? remaining : 2 ** -step
        remaining -= influence
        total += (scores[i] ?? 0) * influence
      }
      return total <= 0.5
    },
  }
}

const sharedClassifier = createWheelClassifier()

export function smoothScrollDuration(input: {
  enabled: boolean
  reducedMotion: boolean
  physicalWheel: boolean
}): number {
  return input.enabled && !input.reducedMotion && input.physicalWheel ? SMOOTH_SCROLL_MS : 0
}

export function attachSmoothScroll(
  host: HTMLElement,
  term: Pick<OstiaTerminal, 'options' | 'modes' | 'buffer'>,
  mac: boolean,
  classifier: WheelClassifier = sharedClassifier,
): () => void {
  const root = host.ownerDocument
  const onWheel = (e: WheelEvent): void => {
    if (!(e.target instanceof Node) || !host.contains(e.target)) return
    const settings = useSettingsStore.getState()
    if (settings.behavior.wheelZoom && zoomStep(e, mac) !== 0) return
    if (wheelRoute(term.modes.mouseTrackingMode, term.buffer.active.type) !== null) return
    classifier.accept(e as WheelSample)
    if (e.deltaY === 0) return
    term.options.smoothScrollDuration = smoothScrollDuration({
      enabled: settings.behavior.wheelSmoothScroll,
      reducedMotion: reducedMotionNow(),
      physicalWheel: classifier.isPhysicalWheel(),
    })
  }
  root.addEventListener('wheel', onWheel, { capture: true, passive: true })
  return () => root.removeEventListener('wheel', onWheel, { capture: true })
}
