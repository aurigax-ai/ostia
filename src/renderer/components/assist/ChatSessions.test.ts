import { describe, expect, it } from 'vitest'
import { relativeTime } from './ChatSessions'

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const ago = (ms: number, locale = 'en'): string => relativeTime(NOW - ms, NOW, locale)

describe('relativeTime', () => {
  it('says this minute for anything under a minute', () => {
    expect(ago(0)).toBe('this minute')
    expect(ago(45_000)).toBe('this minute')
    expect(ago(59_400)).toBe('this minute')
    expect(relativeTime(NOW + 59_400, NOW, 'en')).toBe('this minute')
    expect(relativeTime(Number.NaN, NOW, 'en')).toBe('this minute')
    expect(ago(45_000, 'zh-Hant')).toBe('這一分鐘')
  })

  it('counts in minutes, hours and days, never in a longer unit', () => {
    expect(ago(MINUTE)).toBe('1 minute ago')
    expect(ago(89 * MINUTE)).toBe('1 hour ago')
    expect(ago(23 * HOUR)).toBe('23 hours ago')
    expect(ago(DAY)).toBe('yesterday')
    expect(ago(7 * DAY)).toBe('7 days ago')
    expect(ago(365 * DAY)).toBe('365 days ago')
    expect(ago(2 * HOUR, 'zh-Hant')).toBe('2 小時前')
  })

  it('rounds to the second before choosing the unit', () => {
    expect(relativeTime(NOW + 59_500, NOW, 'en')).toBe('in 1 minute')
    expect(relativeTime(NOW + 2 * HOUR, NOW, 'en')).toBe('in 2 hours')
  })
})
