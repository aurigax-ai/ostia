import { describe, expect, it } from 'vitest'
import { clampTime, formatClock, rateLabel } from './mediaTime'

describe('formatClock', () => {
  it('writes minutes and seconds', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(12.9)).toBe('0:12')
    expect(formatClock(42)).toBe('0:42')
    expect(formatClock(221)).toBe('3:41')
  })

  it('adds hours from one hour on', () => {
    expect(formatClock(3600)).toBe('1:00:00')
    expect(formatClock(3725)).toBe('1:02:05')
  })

  it('shows zero for values that are not a time', () => {
    expect(formatClock(Number.NaN)).toBe('0:00')
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('0:00')
    expect(formatClock(-4)).toBe('0:00')
  })
})

describe('clampTime', () => {
  it('keeps a time inside the media', () => {
    expect(clampTime(-3, 40)).toBe(0)
    expect(clampTime(55, 40)).toBe(40)
    expect(clampTime(12, 40)).toBe(12)
  })

  it('stays at zero while the length is unknown', () => {
    expect(clampTime(5, Number.NaN)).toBe(0)
    expect(clampTime(5, Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('rateLabel', () => {
  it('writes the rate with a multiplication sign', () => {
    expect(rateLabel(1)).toBe('1×')
    expect(rateLabel(1.25)).toBe('1.25×')
  })
})
