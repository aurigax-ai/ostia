import { describe, expect, it } from 'vitest'
import { ageText } from './deviceAge'

const NOW = 1_800_000_000_000

describe('ageText', () => {
  it('SSY-C80 words a device age in minutes, hours and days', () => {
    expect(ageText('en', NOW - 3 * 60_000, NOW)).toBe('3 minutes ago')
    expect(ageText('en', NOW - 5 * 3_600_000, NOW)).toBe('5 hours ago')
    expect(ageText('en', NOW - 4 * 86_400_000, NOW)).toBe('4 days ago')
    expect(ageText('en', NOW + 1000, NOW)).toBe('this minute')
  })
})
