import { describe, expect, it } from 'vitest'
import { createLimiter } from './limiter'

describe('createLimiter', () => {
  it('allows a burst up to the per-minute budget, then refills over time', () => {
    let now = 0
    const limiter = createLimiter(3, () => now)
    expect([limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([
      true,
      true,
      true,
      false,
    ])
    now = 20_000
    expect(limiter.take()).toBe(true)
    expect(limiter.take()).toBe(false)
  })

  it('never allows less than one request per minute', () => {
    const limiter = createLimiter(0, () => 0)
    expect(limiter.take()).toBe(true)
    expect(limiter.take()).toBe(false)
  })
})
