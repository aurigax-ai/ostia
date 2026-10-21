import { en } from '@shared/app/dict'
import { describe, expect, it } from 'vitest'
import {
  agoText,
  DATE_ONLY,
  formatBytes,
  formatDate,
  relativeTimeText,
  TIME_24H,
  TIME_ONLY,
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

  it('says the date is unknown instead of throwing on an invalid one', () => {
    expect(formatDate(Number.NaN, 'en')).toBe(en.formats.unknownDate)
    expect(formatDate(Date.parse('not a date'), 'zh-Hant', DATE_ONLY)).toBe(en.formats.unknownDate)
    expect(formatDate(8.64e15 + 1, 'en')).toBe(en.formats.unknownDate)
  })
})

describe('formatBytes', () => {
  it('steps by 1000, as kB, MB, GB and TB mean, and keeps one decimal above bytes', () => {
    expect(formatBytes(999, 'en')).toBe('999 bytes')
    expect(formatBytes(1000, 'en')).toBe('1 kB')
    expect(formatBytes(1536, 'en')).toBe('1.5 kB')
    expect(formatBytes(16 * 1024 * 1024 + 1, 'en')).toBe('16.8 MB')
    expect(formatBytes(3.25e9, 'en')).toBe('3.3 GB')
    expect(formatBytes(2e12, 'en')).toBe('2 TB')
    expect(formatBytes(5e15, 'en')).toBe('5,000 TB')
  })

  it('moves to the next unit when the rounded value reaches 1000', () => {
    expect(formatBytes(999_960, 'en')).toBe('1 MB')
    expect(formatBytes(999_940, 'en')).toBe('999.9 kB')
  })

  it('spells bytes out in the long form below a kilobyte', () => {
    expect(formatBytes(1, 'en')).toBe('1 byte')
    expect(formatBytes(400, 'en')).toBe('400 bytes')
    expect(formatBytes(400, 'zh-Hant')).toBe('400 byte')
    expect(formatBytes(400, 'de')).toBe('400 Byte')
  })

  it('writes the number and unit in the given locale', () => {
    expect(formatBytes(1536, 'zh-Hant')).toBe('1.5 kB')
    expect(formatBytes(1536, 'de')).toBe('1,5 kB')
  })

  it('writes zero for a negative or non-finite size', () => {
    expect(formatBytes(-5, 'en')).toBe('0 bytes')
    expect(formatBytes(Number.NaN, 'en')).toBe('0 bytes')
    expect(formatBytes(Number.POSITIVE_INFINITY, 'zh-Hant')).toBe('0 byte')
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
