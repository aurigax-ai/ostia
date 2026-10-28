import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loader = vi.hoisted(() => ({ loadMonaco: vi.fn(async () => ({})) }))

vi.mock('./monacoLoader', () => loader)

const { prefetchMonacoWhenQuiet, QUIET_BEFORE_PREFETCH_MS } = await import('./prefetchMonaco')

describe('prefetchMonacoWhenQuiet', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => callback())
    loader.loadMonaco.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('loads Monaco once the human has not touched the keyboard or pointer for a second', () => {
    prefetchMonacoWhenQuiet()
    vi.advanceTimersByTime(QUIET_BEFORE_PREFETCH_MS - 1)
    expect(loader.loadMonaco).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(loader.loadMonaco).toHaveBeenCalledOnce()
  })

  it('waits while the human keeps typing, so a key never waits for the load', () => {
    prefetchMonacoWhenQuiet()
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(QUIET_BEFORE_PREFETCH_MS - 200)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    }
    expect(loader.loadMonaco).not.toHaveBeenCalled()
    vi.advanceTimersByTime(QUIET_BEFORE_PREFETCH_MS)
    expect(loader.loadMonaco).toHaveBeenCalledOnce()
  })
})
