import { describe, expect, it } from 'vitest'
import { guestKeyEvents, guestKeyName } from './guestKeyEvent'

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

  it('follows the typed character on punctuation and digit positions too', () => {
    expect(guestKeyName('Semicolon', 's', false)).toBe('S')
    expect(guestKeyName('KeyQ', "'", false)).toBe("'")
    expect(guestKeyName('Digit1', '&', false)).toBe('&')
    expect(guestKeyName('Slash', 'z', false)).toBe('Z')
    expect(guestKeyName('Semicolon', 'ß', false)).toBe(';')
    expect(guestKeyName('Semicolon', 'ß', true)).toBe(';')
  })

  it('has no name for a key it cannot send', () => {
    expect(guestKeyName('Numpad1', '1', false)).toBeNull()
    expect(guestKeyName('constructor', 'x', false)).toBeNull()
    expect(guestKeyName('', '', false)).toBeNull()
  })
})

describe('guestKeyEvents', () => {
  const input = (over: Record<string, unknown>) => ({
    type: 'keyDown',
    key: 'y',
    code: 'KeyY',
    control: false,
    shift: false,
    alt: false,
    meta: false,
    ...over,
  })
  const alt = { ctrl: false, alt: true, meta: false }

  it('types the character with the key unless Control or Command is held', () => {
    expect(guestKeyEvents(input({}), 'Y', alt)).toHaveLength(2)
    expect(guestKeyEvents(input({}), 'Y', { ...alt, meta: true })).toHaveLength(1)
    expect(guestKeyEvents(input({ type: 'keyUp' }), 'Y', alt)).toHaveLength(1)
  })

  it('sends a carriage return for Enter, so a field gets its newline', () => {
    expect(guestKeyEvents(input({ key: 'Enter', code: 'Enter' }), 'Enter', alt)[1]).toEqual({
      type: 'char',
      keyCode: '\r',
      modifiers: ['alt'],
    })
    expect(guestKeyEvents(input({ key: 'Tab', code: 'Tab' }), 'Tab', alt)).toHaveLength(1)
  })
})
