import { describe, expect, it } from 'vitest'
import { bootstrapDifference, wilson } from './stats'
import { seeded } from './testRandom'

describe('wilson', () => {
  it('matches the known 95% interval for 6 of 11', () => {
    const w = wilson(6, 11)
    expect(w.rate).toBeCloseTo(0.545, 3)
    expect(w.low).toBeCloseTo(0.28, 2)
    expect(w.high).toBeCloseTo(0.79, 2)
  })

  it('stays inside 0 and 1, and is wide for a few sessions', () => {
    expect(wilson(0, 14)).toMatchObject({ rate: 0, low: 0 })
    expect(wilson(14, 14).high).toBe(1)
    expect(wilson(2, 14).high).toBeGreaterThan(0.3)
    expect(wilson(0, 0)).toEqual({ rate: 0, low: 0, high: 0 })
  })

  it('narrows as sessions grow', () => {
    const small = wilson(5, 10)
    const large = wilson(50, 100)
    expect(large.high - large.low).toBeLessThan(small.high - small.low)
  })
})

describe('bootstrapDifference', () => {
  const pairs = (withPass: number, withoutPass: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ withRule: i < withPass, without: i < withoutPass }))

  it('excludes zero for a clear win and brackets the observed difference', () => {
    const d = bootstrapDifference(pairs(20, 2, 20), seeded(1))
    expect(d.difference).toBeCloseTo(0.9, 5)
    expect(d.low).toBeGreaterThan(0)
    expect(d.low).toBeLessThanOrEqual(d.difference)
    expect(d.high).toBeGreaterThanOrEqual(d.difference)
  })

  it('includes zero when the arms look alike', () => {
    const alike = Array.from({ length: 20 }, (_, i) => ({ withRule: i < 10, without: i > 10 }))
    const d = bootstrapDifference(alike, seeded(2))
    expect(d.low).toBeLessThan(0)
    expect(d.high).toBeGreaterThan(0)
  })

  it('goes below zero for a rule that hurts, and is the same for the same seed', () => {
    const hurt = bootstrapDifference(pairs(2, 20, 20), seeded(3))
    expect(hurt.high).toBeLessThan(0)
    expect(bootstrapDifference(pairs(5, 2, 8), seeded(7))).toEqual(
      bootstrapDifference(pairs(5, 2, 8), seeded(7)),
    )
  })

  it('has no pairs, no answer', () => {
    expect(bootstrapDifference([], seeded(1))).toEqual({ difference: 0, low: 0, high: 0 })
  })
})
