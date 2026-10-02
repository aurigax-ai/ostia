import { describe, it, expect } from 'vitest'
import { formatRelativeTime } from './relativeTime'

describe('formatRelativeTime', () => {
  const locale = 'en'
  const now = 1000000000000

  it('formats years ago', () => {
    const then = now - 2 * 365 * 24 * 60 * 60 * 1000
    const result = formatRelativeTime(then, now, locale)
    expect(result).toContain('year')
    expect(result).toContain('2')
  })

  it('formats months ago', () => {
    const then = now - 5 * 30 * 24 * 60 * 60 * 1000
    const result = formatRelativeTime(then, now, locale)
    expect(result).toContain('month')
  })

  it('formats weeks ago', () => {
    const then = now - 3 * 7 * 24 * 60 * 60 * 1000
    const result = formatRelativeTime(then, now, locale)
    expect(result).toContain('week')
  })

  it('formats days ago', () => {
    const then = now - 5 * 24 * 60 * 60 * 1000
    const result = formatRelativeTime(then, now, locale)
    expect(result).toContain('day')
  })

  it('formats hours ago', () => {
    const then = now - 3 * 60 * 60 * 1000
    const result = formatRelativeTime(then, now, locale)
    expect(result).toContain('hour')
  })

  it('formats minutes ago', () => {
    const then = now - 30 * 60 * 1000
    const result = formatRelativeTime(then, now, locale)
    expect(result).toContain('minute')
  })

  it('formats seconds ago', () => {
    const then = now - 45 * 1000
    const result = formatRelativeTime(then, now, locale)
    expect(result).toContain('second')
  })

  it('handles future timestamps', () => {
    const then = now + 2 * 60 * 60 * 1000
    const result = formatRelativeTime(then, now, locale)
    expect(result).toContain('hour')
    expect(result).toContain('in')
  })

  it('uses custom units', () => {
    const customUnits: [Intl.RelativeTimeFormatUnit, number][] = [
      ['day', 86_400_000],
      ['hour', 3_600_000],
      ['minute', 60_000],
    ]
    const then = now - 2 * 365 * 24 * 60 * 60 * 1000
    const result = formatRelativeTime(then, now, locale, customUnits)
    expect(result).not.toContain('year')
  })
})
