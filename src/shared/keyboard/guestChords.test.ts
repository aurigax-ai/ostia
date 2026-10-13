import { describe, expect, it } from 'vitest'
import { DOUBLE_SHIFT, doubleShiftDetector } from './chordSpec'
import {
  MAX_GUEST_CHORDS,
  guestChordKey,
  guestDoubleShift,
  isGuestChordFire,
  normalizeGuestChords,
} from './guestChords'

const input = (over: Record<string, unknown> = {}) => ({
  type: 'keyDown',
  key: 'p',
  code: 'KeyP',
  control: true,
  shift: true,
  alt: false,
  meta: false,
  ...over,
})

describe('normalizeGuestChords', () => {
  it('accepts canonical chord strings and the digit range', () => {
    expect(normalizeGuestChords(['Ctrl+Shift+P', 'Ctrl+1-9'], false)).toEqual([
      'Ctrl+Shift+P',
      'Ctrl+1-9',
    ])
    expect(normalizeGuestChords(['Cmd+K', 'Cmd+['], true)).toEqual(['Cmd+K', 'Cmd+['])
  })

  it('rejects anything that is not a list of canonical chords', () => {
    expect(normalizeGuestChords('Ctrl+Shift+P', false)).toBeNull()
    expect(normalizeGuestChords([7], false)).toBeNull()
    expect(normalizeGuestChords(['ctrl+shift+p'], false)).toBeNull()
    expect(normalizeGuestChords(['Hyper+K'], false)).toBeNull()
    expect(normalizeGuestChords(Array(MAX_GUEST_CHORDS + 1).fill('Ctrl+Shift+P'), false)).toBeNull()
  })
})

describe('guestChordKey', () => {
  const linux = new Set(['Ctrl+Shift+P', 'Ctrl+1-9'])

  it('returns the key of a bound chord on key down only', () => {
    expect(guestChordKey(input(), linux, false)).toEqual({
      key: 'p',
      code: 'KeyP',
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    })
    expect(guestChordKey(input({ type: 'keyUp' }), linux, false)).toBeNull()
  })

  it('matches a digit through the digit range', () => {
    expect(
      guestChordKey(input({ key: '3', code: 'Digit3', shift: false }), linux, false)?.key,
    ).toBe('3')
    expect(
      guestChordKey(input({ key: '0', code: 'Digit0', shift: false }), linux, false),
    ).toBeNull()
  })

  it('leaves unbound keys, plain typing and the macOS clipboard keys to the page', () => {
    expect(guestChordKey(input({ key: 'q', code: 'KeyQ' }), linux, false)).toBeNull()
    expect(guestChordKey(input({ control: false, shift: false }), linux, false)).toBeNull()
    expect(guestChordKey(input(), new Set(), false)).toBeNull()
    const mac = new Set(['Cmd+C', 'Cmd+V', 'Cmd+K'])
    const cmd = (key: string) =>
      input({ key, code: `Key${key.toUpperCase()}`, control: false, shift: false, meta: true })
    expect(guestChordKey(cmd('c'), mac, true)).toBeNull()
    expect(guestChordKey(cmd('v'), mac, true)).toBeNull()
    expect(guestChordKey(cmd('k'), mac, true)?.key).toBe('k')
  })
})

describe('guestDoubleShift', () => {
  const shift = (type: string, over: Record<string, unknown> = {}) =>
    input({ type, key: 'Shift', code: 'ShiftLeft', control: false, ...over })

  it('reports two quick lone Shift taps when Shift+Shift is bound', () => {
    const detector = doubleShiftDetector()
    const bound = new Set([DOUBLE_SHIFT])
    expect(normalizeGuestChords([DOUBLE_SHIFT], true)).toEqual([DOUBLE_SHIFT])
    expect(guestDoubleShift(shift('keyDown'), bound, detector, 0)).toBe(false)
    expect(guestDoubleShift(shift('keyUp'), bound, detector, 60)).toBe(false)
    expect(guestDoubleShift(shift('keyDown'), bound, detector, 150)).toBe(false)
    expect(guestDoubleShift(shift('keyUp'), bound, detector, 210)).toBe(true)
  })

  it('ignores the taps when nothing is bound to them or Shift repeats', () => {
    const unbound = doubleShiftDetector()
    const taps = [shift('keyDown'), shift('keyUp'), shift('keyDown'), shift('keyUp')]
    expect(taps.map((t, i) => guestDoubleShift(t, new Set(), unbound, i * 50))).not.toContain(true)
    const repeating = doubleShiftDetector()
    const bound = new Set([DOUBLE_SHIFT])
    const held = [
      shift('keyDown'),
      shift('keyDown', { isAutoRepeat: true }),
      shift('keyDown', { isAutoRepeat: true }),
      shift('keyUp'),
      shift('keyDown'),
      shift('keyUp'),
    ]
    expect(held.map((t, i) => guestDoubleShift(t, bound, repeating, i * 40))).not.toContain(true)
  })
})

describe('isGuestChordFire', () => {
  it('accepts a guest id and a key, and nothing else', () => {
    const key = { key: 'k', ctrlKey: false, shiftKey: false, altKey: false, metaKey: true }
    expect(isGuestChordFire({ guestId: 4, key })).toBe(true)
    expect(isGuestChordFire({ guestId: '4', key })).toBe(false)
    expect(isGuestChordFire({ guestId: 4, key: { ...key, metaKey: 'yes' } })).toBe(false)
    expect(isGuestChordFire(null)).toBe(false)
  })
})
