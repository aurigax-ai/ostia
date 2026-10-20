import { describe, expect, it } from 'vitest'
import { guestKeyName } from './guestKeyEvent'

describe('guestKeyName', () => {
  it('names the physical key from its code, whatever the layout typed', () => {
    expect(guestKeyName('KeyQ', 'q', false)).toBe('Q')
    expect(guestKeyName('Digit7', '7', false)).toBe('7')
    expect(guestKeyName('F12', 'F12', false)).toBe('F12')
    expect(guestKeyName('ArrowLeft', 'ArrowLeft', false)).toBe('Left')
    expect(guestKeyName('BracketLeft', '[', false)).toBe('[')
    expect(guestKeyName('ShiftRight', 'Shift', false)).toBe('Shift')
  })

  it('follows the typed letter unless Option has composed it', () => {
    expect(guestKeyName('KeyC', 'j', false)).toBe('J')
    expect(guestKeyName('KeyC', 'ç', true)).toBe('C')
    expect(guestKeyName('KeyQ', 'é', false)).toBe('Q')
  })

  it('has no name for a key it cannot send', () => {
    expect(guestKeyName('Numpad1', '1', false)).toBeNull()
    expect(guestKeyName('constructor', 'x', false)).toBeNull()
    expect(guestKeyName('', '', false)).toBeNull()
  })
})
