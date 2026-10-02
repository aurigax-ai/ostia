import { describe, expect, it } from 'vitest'
import { type RelativeStep, formatRelative } from './relativeTime'

const STEPS: RelativeStep[] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
]
const MINUTE = 60
const HOUR = 3_600
const DAY = 86_400

const en = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const zhHant = new Intl.RelativeTimeFormat('zh-Hant', { numeric: 'auto' })
const ago = (seconds: number): string => formatRelative(-seconds, STEPS, en)

describe('formatRelative', () => {
  it('counts in the first step the difference reaches', () => {
    expect(ago(MINUTE)).toBe('1 minute ago')
    expect(ago(89 * MINUTE)).toBe('1 hour ago')
    expect(ago(23 * HOUR)).toBe('23 hours ago')
    expect(ago(24 * HOUR)).toBe('yesterday')
    expect(ago(6 * DAY)).toBe('6 days ago')
    expect(ago(7 * DAY)).toBe('last week')
    expect(ago(29 * DAY)).toBe('4 weeks ago')
    expect(ago(30 * DAY)).toBe('last month')
    expect(ago(364 * DAY)).toBe('12 months ago')
    expect(ago(365 * DAY)).toBe('last year')
  })

  it('counts in the last step when the difference reaches none', () => {
    expect(ago(59)).toBe('59 seconds ago')
    expect(ago(0.6)).toBe('1 second ago')
    expect(ago(0.4)).toBe('now')
    expect(ago(0)).toBe('now')
    expect(formatRelative(-45, [['minute', 60]], en)).toBe('1 minute ago')
    expect(formatRelative(-20, [['minute', 60]], en)).toBe('this minute')
  })

  it('formats a time ahead of now', () => {
    expect(formatRelative(45, STEPS, en)).toBe('in 45 seconds')
    expect(formatRelative(2 * HOUR, STEPS, en)).toBe('in 2 hours')
    expect(formatRelative(DAY, STEPS, en)).toBe('tomorrow')
  })

  it('writes in the language of the formatter it is given', () => {
    expect(formatRelative(-45, STEPS, zhHant)).toBe('45 秒前')
    expect(formatRelative(-DAY, STEPS, zhHant)).toBe('昨天')
    expect(formatRelative(2 * HOUR, STEPS, zhHant)).toBe('2 小時後')
  })

  it('refuses a difference that is not a number, like the formatter itself', () => {
    expect(() => formatRelative(Number.NaN, STEPS, en)).toThrow(RangeError)
  })
})
