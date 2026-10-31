import { describe, expect, it } from 'vitest'
import { isStale, usageLineParts, weeklyPace } from './usageLine'

const MIN = 60_000
const DAY = 24 * 60 * MIN
const NOW = Date.UTC(2026, 9, 23, 12)
const STRINGS = {
  usageSession: 'Session {percent}%',
  usageWeekly: 'Weekly {percent}%',
  usagePace: 'pace {percent}%',
  usageResets: 'resets {when}',
}

describe('usageLineParts', () => {
  it('names session, weekly, the share of the week gone and the weekly reset day', () => {
    const usage = {
      session: { percent: 41.6, resetsAt: NOW + 60 * MIN },
      weekly: { percent: 18.2, resetsAt: NOW + 4 * DAY },
      checkedAt: NOW,
    }
    expect(usageLineParts(usage, NOW, 'en-US', STRINGS)).toEqual([
      'Session 42%',
      'Weekly 18%',
      'pace 43%',
      'resets Tue',
    ])
  })

  it('names the hour when the week resets within a day', () => {
    const usage = {
      session: null,
      weekly: { percent: 90, resetsAt: NOW + 3 * 60 * MIN },
      checkedAt: NOW,
    }
    expect(usageLineParts(usage, NOW, 'en-US', STRINGS)).toEqual([
      'Weekly 90%',
      'pace 98%',
      'resets 3:00 PM',
    ])
  })

  it('shows a window whose reset passed as empty, without a pace or reset for it', () => {
    const usage = {
      session: { percent: 80, resetsAt: NOW - 1 },
      weekly: { percent: 50, resetsAt: NOW - 1 },
      checkedAt: NOW - DAY,
    }
    expect(usageLineParts(usage, NOW, 'en-US', STRINGS)).toEqual(['Session 0%', 'Weekly 0%'])
  })

  it('leaves out a window the answer did not carry', () => {
    expect(
      usageLineParts({ session: null, weekly: null, checkedAt: NOW }, NOW, 'en-US', STRINGS),
    ).toEqual([])
  })
})

describe('weeklyPace', () => {
  it('is the share of the seven days already gone', () => {
    expect(weeklyPace({ percent: 0, resetsAt: NOW + 7 * DAY }, NOW)).toBe(0)
    expect(weeklyPace({ percent: 0, resetsAt: NOW + 3.5 * DAY }, NOW)).toBe(50)
    expect(weeklyPace({ percent: 0, resetsAt: NOW + 8 * DAY }, NOW)).toBe(0)
  })
})

describe('isStale', () => {
  it('marks an answer older than half an hour', () => {
    expect(isStale({ session: null, weekly: null, checkedAt: NOW - 30 * MIN }, NOW)).toBe(false)
    expect(isStale({ session: null, weekly: null, checkedAt: NOW - 31 * MIN }, NOW)).toBe(true)
  })
})
