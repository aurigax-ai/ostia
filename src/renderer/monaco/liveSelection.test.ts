import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { debounce } from 'es-toolkit'

describe('debounce with cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('debounces function calls with cancel on cleanup', () => {
    const mockFn = vi.fn()
    const debouncedFn = debounce(mockFn, 150)

    debouncedFn()
    debouncedFn()
    debouncedFn()

    expect(mockFn).not.toHaveBeenCalled()

    vi.advanceTimersByTime(150)
    expect(mockFn).toHaveBeenCalledOnce()

    debouncedFn()
    debouncedFn()

    debouncedFn.cancel()

    vi.advanceTimersByTime(150)
    expect(mockFn).toHaveBeenCalledOnce()
  })
})
