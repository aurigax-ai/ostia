import { describe, expect, it } from 'vitest'
import { KILL_LINE, macLineEditKey } from './macLineKeys'

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
  })
})
