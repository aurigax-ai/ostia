import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frameCoalesce } from './frameCoalesce'

describe('frameCoalesce', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs once per frame however many calls arrive', () => {
    const fn = vi.fn()
    const run = frameCoalesce(fn)
    for (let i = 0; i < 500; i++) run()
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersToNextFrame()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('schedules again after the frame ran', () => {
    const fn = vi.fn()
    const run = frameCoalesce(fn)
    run()
    vi.advanceTimersToNextFrame()
    run()
    vi.advanceTimersToNextFrame()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does not run after cancel', () => {
    const fn = vi.fn()
    const run = frameCoalesce(fn)
    run()
    run.cancel()
    vi.advanceTimersToNextFrame()
    expect(fn).not.toHaveBeenCalled()
  })
})
