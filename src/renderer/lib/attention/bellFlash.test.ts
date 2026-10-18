import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BELL_FLASH_MIN_INTERVAL_MS, type BellFlashRequest, createBellFlash } from './bellFlash'

const base: BellFlashRequest = {
  enabled: true,
  durationMs: 400,
  easing: 'out',
  reducedMotion: false,
  now: 10_000,
}

let container: HTMLElement

const flashes = (): number => container.querySelectorAll('.bell-flash').length

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  vi.useRealTimers()
  container.remove()
})

describe('createBellFlash', () => {
  it('adds one overlay that carries the duration and easing, then removes it', () => {
    const bell = createBellFlash(container)
    expect(bell.flash({ ...base, easing: 'linear' })).toBe(true)
    const el = container.querySelector<HTMLElement>('.bell-flash')
    expect(el?.style.getPropertyValue('--bell-flash-ms')).toBe('400ms')
    expect(el?.dataset.easing).toBe('linear')
    expect(el?.getAttribute('aria-hidden')).toBe('true')
    vi.advanceTimersByTime(500)
    expect(flashes()).toBe(0)
  })

  it('flashes once for repeated bells inside the duration', () => {
    const bell = createBellFlash(container)
    expect(bell.flash({ ...base, now: 10_000 })).toBe(true)
    expect(bell.flash({ ...base, now: 10_100 })).toBe(false)
    expect(bell.flash({ ...base, now: 10_399 })).toBe(false)
    expect(flashes()).toBe(1)
  })

  it('flashes once for a continuous stream and again once it has been quiet for the duration', () => {
    const bell = createBellFlash(container)
    let flashed = 0
    for (let t = 0; t < 2000; t += 100) {
      if (bell.flash({ ...base, now: 30_000 + t })) flashed++
    }
    expect(flashed).toBe(1)
    expect(bell.flash({ ...base, now: 30_000 + 1900 + 399 })).toBe(false)
    expect(bell.flash({ ...base, now: 30_000 + 1900 + 399 + 400 })).toBe(true)
  })

  it('carries the theme colour onto the overlay and leaves it unset otherwise', () => {
    const bell = createBellFlash(container)
    bell.flash({ ...base, color: '#abcdef', now: 40_000 })
    const el = container.querySelector<HTMLElement>('.bell-flash')
    expect(el?.style.getPropertyValue('--bell-flash-color')).toBe('#abcdef')
    bell.flash({ ...base, now: 50_000 })
    expect(
      container
        .querySelector<HTMLElement>('.bell-flash')
        ?.style.getPropertyValue('--bell-flash-color'),
    ).toBe('')
  })

  it('flashes again once the duration has passed', () => {
    const bell = createBellFlash(container)
    expect(bell.flash({ ...base, now: 10_000 })).toBe(true)
    expect(bell.flash({ ...base, now: 10_400 })).toBe(true)
    expect(flashes()).toBe(1)
  })

  it('never flashes more than three times a second, even for a very short duration', () => {
    const bell = createBellFlash(container)
    const short = { ...base, durationMs: 50 }
    expect(bell.flash({ ...short, now: 20_000 })).toBe(true)
    expect(bell.flash({ ...short, now: 20_000 + BELL_FLASH_MIN_INTERVAL_MS - 1 })).toBe(false)
    expect(bell.flash({ ...short, now: 20_000 + BELL_FLASH_MIN_INTERVAL_MS * 2 - 1 })).toBe(true)
    expect(BELL_FLASH_MIN_INTERVAL_MS * 3).toBeGreaterThan(1000)
  })

  it('does nothing when the setting is off', () => {
    const bell = createBellFlash(container)
    expect(bell.flash({ ...base, enabled: false })).toBe(false)
    expect(flashes()).toBe(0)
  })

  it('does nothing under reduced motion and does not start the rate limit', () => {
    const bell = createBellFlash(container)
    expect(bell.flash({ ...base, reducedMotion: true })).toBe(false)
    expect(flashes()).toBe(0)
    expect(bell.flash({ ...base, now: base.now + 1 })).toBe(true)
  })

  it('removes a running overlay on dispose and leaves no timer behind', () => {
    const bell = createBellFlash(container)
    bell.flash(base)
    bell.dispose()
    expect(flashes()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
