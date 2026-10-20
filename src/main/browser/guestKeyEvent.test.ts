import { describe, expect, it } from 'vitest'
import { guestKeyName } from './guestKeyEvent'

describe('guestKeyName', () => {
  it('names the physical key from its code, whatever the layout typed', () => {
    expect(guestKeyName('KeyQ')).toBe('Q')
    expect(guestKeyName('Digit7')).toBe('7')
    expect(guestKeyName('F12')).toBe('F12')
    expect(guestKeyName('ArrowLeft')).toBe('Left')
    expect(guestKeyName('BracketLeft')).toBe('[')
    expect(guestKeyName('ShiftRight')).toBe('Shift')
  })

  it('has no name for a key it cannot send', () => {
    expect(guestKeyName('Numpad1')).toBeNull()
    expect(guestKeyName('constructor')).toBeNull()
    expect(guestKeyName('')).toBeNull()
  })
})
