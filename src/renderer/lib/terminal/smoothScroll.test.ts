import { useSettingsStore } from '@/stores/app/settingsStore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SMOOTH_SCROLL_MS,
  type WheelSample,
  attachSmoothScroll,
  isPhysicalWheel,
  smoothScrollDuration,
} from './smoothScroll'

const PIXEL = WheelEvent.DOM_DELTA_PIXEL
const LINE = WheelEvent.DOM_DELTA_LINE

const notch: WheelSample = { deltaMode: PIXEL, deltaX: 0, deltaY: 100, wheelDeltaY: -120 }
const trackpad: WheelSample = { deltaMode: PIXEL, deltaX: 0, deltaY: 7, wheelDeltaY: -21 }

describe('isPhysicalWheel', () => {
  it('treats line and page delta modes as a mouse wheel', () => {
    expect(isPhysicalWheel({ deltaMode: LINE, deltaX: 0, deltaY: 3 })).toBe(true)
    expect(isPhysicalWheel({ deltaMode: WheelEvent.DOM_DELTA_PAGE, deltaX: 0, deltaY: 1 })).toBe(
      true,
    )
  })

  it('treats pixel deltas in whole notches as a mouse wheel', () => {
    expect(isPhysicalWheel(notch)).toBe(true)
    expect(isPhysicalWheel({ ...notch, wheelDeltaY: 240 })).toBe(true)
  })

  it('treats fractional pixel deltas as a trackpad', () => {
    expect(isPhysicalWheel(trackpad)).toBe(false)
    expect(isPhysicalWheel({ ...trackpad, wheelDeltaY: 0 })).toBe(false)
  })

  it('treats diagonal pixel deltas and pixel deltas without a legacy value as a trackpad', () => {
    expect(isPhysicalWheel({ ...notch, deltaX: 4 })).toBe(false)
    expect(isPhysicalWheel({ deltaMode: PIXEL, deltaX: 0, deltaY: 100 })).toBe(false)
  })
})

describe('smoothScrollDuration', () => {
  const on = { enabled: true, reducedMotion: false, physicalWheel: true }

  it('animates only a physical wheel with the setting on and motion allowed', () => {
    expect(smoothScrollDuration(on)).toBe(SMOOTH_SCROLL_MS)
    expect(smoothScrollDuration({ ...on, physicalWheel: false })).toBe(0)
    expect(smoothScrollDuration({ ...on, reducedMotion: true })).toBe(0)
    expect(smoothScrollDuration({ ...on, enabled: false })).toBe(0)
  })
})

describe('attachSmoothScroll', () => {
  let osReduced = false

  beforeEach(() => {
    osReduced = false
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        ({
          matches: osReduced,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    )
    useSettingsStore.getState().setBehavior({ smoothScrolling: false })
    useSettingsStore.getState().setByPath('appearance.motion', 'full')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function scroll(host: HTMLElement, sample: WheelSample): void {
    const e = new WheelEvent('wheel', {
      deltaMode: sample.deltaMode,
      deltaX: sample.deltaX,
      deltaY: sample.deltaY,
    })
    Object.defineProperty(e, 'wheelDeltaY', { value: sample.wheelDeltaY })
    host.dispatchEvent(e)
  }

  function setup() {
    const host = document.createElement('div')
    const term = { options: { smoothScrollDuration: 0 } }
    const detach = attachSmoothScroll(host, term)
    return { host, term, detach }
  }

  it('keeps every wheel at 0 while the setting is off', () => {
    const { host, term } = setup()
    scroll(host, notch)
    expect(term.options.smoothScrollDuration).toBe(0)
  })

  it('switches per event between a mouse wheel and a trackpad', () => {
    useSettingsStore.getState().setBehavior({ smoothScrolling: true })
    const { host, term } = setup()
    scroll(host, notch)
    expect(term.options.smoothScrollDuration).toBe(SMOOTH_SCROLL_MS)
    scroll(host, trackpad)
    expect(term.options.smoothScrollDuration).toBe(0)
  })

  it('never animates when reduced motion is set in the app or by the system', () => {
    useSettingsStore.getState().setBehavior({ smoothScrolling: true })
    const { host, term } = setup()
    useSettingsStore.getState().setByPath('appearance.motion', 'reduced')
    scroll(host, notch)
    expect(term.options.smoothScrollDuration).toBe(0)
    useSettingsStore.getState().setByPath('appearance.motion', 'system')
    osReduced = true
    scroll(host, notch)
    expect(term.options.smoothScrollDuration).toBe(0)
    osReduced = false
    scroll(host, notch)
    expect(term.options.smoothScrollDuration).toBe(SMOOTH_SCROLL_MS)
  })

  it('stops listening after detach', () => {
    useSettingsStore.getState().setBehavior({ smoothScrolling: true })
    const { host, term, detach } = setup()
    detach()
    scroll(host, notch)
    expect(term.options.smoothScrollDuration).toBe(0)
  })
})
