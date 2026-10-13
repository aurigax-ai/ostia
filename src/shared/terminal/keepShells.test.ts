import { describe, expect, it } from 'vitest'
import { parseKeepShells } from './keepShells'

describe('parseKeepShells', () => {
  it('KSH-C3 reads anything but true as off', () => {
    expect(parseKeepShells(true)).toBe(true)
    for (const raw of ['yes', 'true', 1, null, undefined, {}, false]) {
      expect(parseKeepShells(raw)).toBe(false)
    }
  })
})
