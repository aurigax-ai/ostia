import { describe, expect, it } from 'vitest'
import {
  DATE_ONLY,
  TIME_24H,
  TIME_ONLY,
  agoText,
  formatBytes,
  formatDate,
  relativeTimeText,
} from './localeFormat'

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const ago = (ms: number, locale = 'en'): string => relativeTimeText(NOW - ms, NOW, locale)

describe('formatDate', () => {
  const at = Date.UTC(2026, 9, 14, 13, 4, 5)

  it('writes a date and time in the given locale', () => {
    expect(formatDate(at, 'en')).toBe('10/14/2026, 1:04:05 PM')
    expect(formatDate(at, 'zh-Hant')).toBe('2026/10/14\u2009下午1:04:05')
  })

  it('writes a date alone, or a time with or without a 24-hour clock', () => {
    expect(formatDate(at, 'zh-Hant', DATE_ONLY)).toBe('2026/10/14')
    expect(formatDate(at, 'zh-Hant', TIME_24H)).toBe('13:04:05')
    expect(formatDate(at, 'zh-Hant', TIME_ONLY)).toBe('下午1:04:05')
    expect(formatDate(at, 'en', TIME_ONLY)).toBe('1:04:05 PM')
  })
})

describe('formatBytes', () => {
  it('steps by 1024 and keeps one decimal above bytes', () => {
    expect(formatBytes(0, 'en')).toBe('0 byte')
    expect(formatBytes(1023, 'en')).toBe('1,023 byte')
    expect(formatBytes(1536, 'en')).toBe('1.5 kB')
    expect(formatBytes(16 * 1024 * 1024 + 1, 'en')).toBe('16 MB')
    expect(formatBytes(3.25 * 1024 ** 3, 'en')).toBe('3.3 GB')
    expect(formatBytes(2048 * 1024 ** 3, 'en')).toBe('2,048 GB')
  })

  it('writes the number and unit in the given locale', () => {
    expect(formatBytes(1536, 'zh-Hant')).toBe('1.5 kB')
    expect(formatBytes(1536, 'de')).toBe('1,5 kB')
    expect(formatBytes(400, 'de')).toBe('400 Byte')
  })
})

describe('relativeTimeText', () => {
  it('says this minute for anything under a minute', () => {
    expect(ago(0)).toBe('this minute')
    expect(ago(45_000)).toBe('this minute')
    expect(ago(59_400)).toBe('this minute')
    expect(relativeTimeText(NOW + 59_400, NOW, 'en')).toBe('this minute')
    expect(relativeTimeText(Number.NaN, NOW, 'en')).toBe('this minute')
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
    expect(relativeTimeText(NOW + 59_500, NOW, 'en')).toBe('in 1 minute')
    expect(relativeTimeText(NOW + 2 * HOUR, NOW, 'en')).toBe('in 2 hours')
  })
})

describe('agoText', () => {
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'always', style: 'short' })

  it('says just now under a minute, then minutes, hours and days', () => {
    expect(agoText(59_000, 'just now', format)).toBe('just now')
    expect(agoText(3 * 60_000, 'just now', format)).toBe('3 min. ago')
    expect(agoText(2 * 3_600_000 + 5, 'just now', format)).toBe('2 hr. ago')
    expect(agoText(49 * 3_600_000, 'just now', format)).toBe('2 days ago')
  })
})
