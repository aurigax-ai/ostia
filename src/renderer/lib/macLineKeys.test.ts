import { describe, expect, it } from 'vitest'
import {
  KILL_LINE,
  LINE_END,
  LINE_START,
  WORD_BACK,
  WORD_FORWARD,
  macLineEditKey,
} from './macLineKeys'

const key = (
  k: string,
  mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {},
) => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
})

describe('macLineEditKey', () => {
  it('sends Ctrl+U for Cmd+Backspace on macOS, like Terminal and iTerm, so the shell deletes the line', () => {
    expect(macLineEditKey(key('Backspace', { metaKey: true }), true)).toBe(KILL_LINE)
    expect(KILL_LINE).toBe('\x15')
  })

  it('leaves plain Backspace, other Cmd keys and Cmd+Backspace with more modifiers to the terminal', () => {
    expect(macLineEditKey(key('Backspace'), true)).toBeNull()
    expect(macLineEditKey(key('k', { metaKey: true }), true)).toBeNull()
    expect(macLineEditKey(key('Backspace', { metaKey: true, shiftKey: true }), true)).toBeNull()
    expect(macLineEditKey(key('Backspace', { metaKey: true, altKey: true }), true)).toBeNull()
    expect(macLineEditKey(key('Backspace', { metaKey: true, ctrlKey: true }), true)).toBeNull()
  })

  it('does nothing outside macOS, where the Super key is not a line-editing modifier', () => {
    expect(macLineEditKey(key('Backspace', { metaKey: true }), false)).toBeNull()
    expect(macLineEditKey(key('ArrowLeft', { metaKey: true }), false)).toBeNull()
    expect(macLineEditKey(key('ArrowLeft', { altKey: true }), false)).toBeNull()
  })

  it('sends Ctrl+A and Ctrl+E for Cmd+Left and Cmd+Right so the cursor jumps to the line ends', () => {
    expect(macLineEditKey(key('ArrowLeft', { metaKey: true }), true)).toBe(LINE_START)
    expect(macLineEditKey(key('ArrowRight', { metaKey: true }), true)).toBe(LINE_END)
    expect([LINE_START, LINE_END]).toEqual(['\x01', '\x05'])
  })

  it('sends ESC b and ESC f for Option+Left and Option+Right so the cursor moves by words', () => {
    expect(macLineEditKey(key('ArrowLeft', { altKey: true }), true)).toBe(WORD_BACK)
    expect(macLineEditKey(key('ArrowRight', { altKey: true }), true)).toBe(WORD_FORWARD)
    expect([WORD_BACK, WORD_FORWARD]).toEqual(['\x1bb', '\x1bf'])
  })

  it('leaves Option+arrows to the terminal when Option is the Meta key', () => {
    expect(macLineEditKey(key('ArrowLeft', { altKey: true }), true, true)).toBeNull()
    expect(macLineEditKey(key('ArrowRight', { altKey: true }), true, true)).toBeNull()
    expect(macLineEditKey(key('ArrowLeft', { metaKey: true }), true, true)).toBe(LINE_START)
  })

  it('leaves arrows with Shift, Ctrl, both Cmd and Option, or vertical arrows to the terminal', () => {
    expect(macLineEditKey(key('ArrowLeft'), true)).toBeNull()
    expect(macLineEditKey(key('ArrowLeft', { metaKey: true, shiftKey: true }), true)).toBeNull()
    expect(macLineEditKey(key('ArrowLeft', { altKey: true, shiftKey: true }), true)).toBeNull()
    expect(macLineEditKey(key('ArrowLeft', { metaKey: true, ctrlKey: true }), true)).toBeNull()
    expect(macLineEditKey(key('ArrowLeft', { metaKey: true, altKey: true }), true)).toBeNull()
    expect(macLineEditKey(key('ArrowUp', { altKey: true }), true)).toBeNull()
    expect(macLineEditKey(key('ArrowUp', { metaKey: true }), true)).toBeNull()
    expect(macLineEditKey(key('Backspace', { altKey: true }), true)).toBeNull()
  })
})
