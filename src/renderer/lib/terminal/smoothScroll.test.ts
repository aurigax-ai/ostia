import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import {
  attachSmoothScroll,
  createWheelClassifier,
  SMOOTH_SCROLL_MS,
  smoothScrollDuration,
  type WheelSample,
} from './smoothScroll'

const PIXEL = WheelEvent.DOM_DELTA_PIXEL
const LINE = WheelEvent.DOM_DELTA_LINE

const notch: WheelSample = { deltaMode: PIXEL, deltaX: 0, deltaY: -100, wheelDeltaY: 120 }
const trackpad: WheelSample = { deltaMode: PIXEL, deltaX: 0, deltaY: -7, wheelDeltaY: 21 }

function classify(...samples: WheelSample[]): boolean {
  const classifier = createWheelClassifier()
  for (const sample of samples) classifier.accept(sample)
  return classifier.isPhysicalWheel()
}

describe('createWheelClassifier', () => {
  it('has no wheel before the first event', () => {
    expect(createWheelClassifier().isPhysicalWheel()).toBe(false)
  })

  it('treats whole notches and line deltas as a mouse wheel', () => {
    expect(classify(notch)).toBe(true)
    expect(classify(notch, notch, { ...notch, wheelDeltaY: 240 })).toBe(true)
    expect(classify({ deltaMode: LINE, deltaX: 0, deltaY: 3 })).toBe(true)
    expect(classify({ deltaMode: PIXEL, deltaX: 0, deltaY: 80 })).toBe(true)
  })

  it('treats fractional and diagonal deltas as a trackpad', () => {
    expect(classify(trackpad)).toBe(false)
    expect(classify({ ...notch, deltaX: 4, wheelDeltaX: -12 })).toBe(false)
  })

  it('weighs the last five events, so one whole notch inside a trackpad swipe stays a trackpad', () => {
    const swipe = [135, 156, 183, 156].map((w) => ({ ...trackpad, deltaY: -w / 3, wheelDeltaY: w }))
    expect(classify(...swipe, notch)).toBe(false)
    expect(classify(...swipe, notch, notch, notch)).toBe(true)
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
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeEach(() => {
    settingsInit = useSettingsStore.getState()
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
    useSettingsStore.getState().setBehavior({ wheelSmoothScroll: false })
    useSettingsStore.getState().setByPath('appearance.motion', 'full')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useSettingsStore.setState(settingsInit, true)
    document.body.replaceChildren()
  })

  function scroll(host: HTMLElement, sample: WheelSample & { metaKey?: boolean }): void {
    const e = new WheelEvent('wheel', {
      bubbles: true,
      deltaMode: sample.deltaMode,
      deltaX: sample.deltaX,
      deltaY: sample.deltaY,
      metaKey: sample.metaKey ?? false,
    })
    Object.defineProperty(e, 'wheelDeltaX', { value: sample.wheelDeltaX ?? 0 })
    Object.defineProperty(e, 'wheelDeltaY', { value: sample.wheelDeltaY })
    host.dispatchEvent(e)
  }

  function setup() {
    const host = document.createElement('div')
    document.body.append(host)
    const screen = { mouseTrackingMode: 'none', bufferType: 'normal' }
    const term = {
      options: { smoothScrollDuration: 0 },
      get modes() {
        return { mouseTrackingMode: screen.mouseTrackingMode }
      },
      get buffer() {
        return { active: { type: screen.bufferType } }
      },
    } as unknown as Parameters<typeof attachSmoothScroll>[1]
    const detach = attachSmoothScroll(host, term, true, createWheelClassifier())
    return { host, term, screen, detach }
  }

  it('keeps every wheel at 0 while the setting is off', () => {
    const { host, term } = setup()
    scroll(host, notch)
    expect(term.options.smoothScrollDuration).toBe(0)
  })

  it('follows the recent history between a mouse wheel and a trackpad', () => {
    useSettingsStore.getState().setBehavior({ wheelSmoothScroll: true })
    const { host, term } = setup()
    scroll(host, notch)
    expect(term.options.smoothScrollDuration).toBe(SMOOTH_SCROLL_MS)
    scroll(host, trackpad)
    scroll(host, trackpad)
    expect(term.options.smoothScrollDuration).toBe(0)
  })

  it('leaves the duration alone for wheel events the scrollback does not scroll on', () => {
    useSettingsStore.getState().setBehavior({ wheelSmoothScroll: true, wheelZoom: true })
    const { host, term, screen } = setup()
    scroll(host, notch)
    expect(term.options.smoothScrollDuration).toBe(SMOOTH_SCROLL_MS)
    scroll(host, { deltaMode: PIXEL, deltaX: 30, deltaY: 0, wheelDeltaX: -90, wheelDeltaY: 0 })
    scroll(host, { ...trackpad, metaKey: true })
    screen.bufferType = 'alternate'
    scroll(host, trackpad)
    screen.bufferType = 'normal'
    screen.mouseTrackingMode = 'any'
    scroll(host, trackpad)
    expect(term.options.smoothScrollDuration).toBe(SMOOTH_SCROLL_MS)
  })

  it('never animates when reduced motion is set in the app or by the system', () => {
    useSettingsStore.getState().setBehavior({ wheelSmoothScroll: true })
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
    useSettingsStore.getState().setBehavior({ wheelSmoothScroll: true })
    const { host, term, detach } = setup()
    detach()
    scroll(host, notch)
    expect(term.options.smoothScrollDuration).toBe(0)
  })
})
