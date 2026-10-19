import { describe, expect, it } from 'vitest'
import { FRIENDLY_NAME, friendlyNameFrom } from './friendlyName'

describe('friendlyNameFrom', () => {
  it('RDS-C13 makes two lowercase words joined by a hyphen for every pick', () => {
    for (let n = 0; n < 40; n++) {
      expect(friendlyNameFrom((count) => (n * 7) % count)).toMatch(FRIENDLY_NAME)
    }
  })

  it('RDS-C14 depends only on the pick, never on the machine', () => {
    const pick = (count: number): number => 3 % count
    expect(friendlyNameFrom(pick)).toBe(friendlyNameFrom(pick))
  })
})
