import { describe, expect, it } from 'vitest'
import { parseChord } from './chordSpec'
import {
  KEYBOARD_PLATFORMS,
  TERMINAL_KEYMAPS,
  keyboardPlatform,
  terminalKeymapIn,
  terminalKeymapKeys,
  terminalKeymapsFor,
} from './keyboardPresets'
import { sendData } from './terminalKeys'

describe('keyboardPlatform', () => {
  it('treats anything that is not macOS as Linux', () => {
    expect(keyboardPlatform('darwin')).toBe('mac')
    expect(keyboardPlatform('linux')).toBe('linux')
    expect(keyboardPlatform('freebsd')).toBe('linux')
  })
})

describe('preset tables', () => {
  it('list only what a platform has: Natural Text Editing is macOS only', () => {
    expect(terminalKeymapsFor('mac').map((k) => k.id)).toEqual([
      'ostia',
      'natural-text-editing',
      'none',
    ])
    expect(terminalKeymapsFor('linux').map((k) => k.id)).toEqual(['ostia', 'none'])
  })

  it('hold only chords that parse and sequences that decode', () => {
    for (const keymap of TERMINAL_KEYMAPS) {
      for (const platform of KEYBOARD_PLATFORMS) {
        for (const [keys, send] of Object.entries(keymap.keys[platform] ?? {})) {
          const at = `${keymap.id}/${platform}/${keys}`
          expect(parseChord(keys, platform === 'mac'), at).not.toBeNull()
          expect(sendData(send), at).not.toBeNull()
        }
      }
    }
    expect(new Set(TERMINAL_KEYMAPS.map((k) => k.id)).size).toBe(TERMINAL_KEYMAPS.length)
  })

  it('resolve a choice the platform lacks, or none, to the platform default', () => {
    expect(terminalKeymapIn('natural-text-editing', 'mac')).toBe('natural-text-editing')
    expect(terminalKeymapIn('natural-text-editing', 'linux')).toBe('ostia')
    expect(terminalKeymapIn('none', 'linux')).toBe('none')
    expect(terminalKeymapIn(null, 'mac')).toBe('ostia')
    expect(terminalKeymapIn('gone', 'mac')).toBe('ostia')
    expect(Object.keys(terminalKeymapKeys('ostia', 'linux'))).toEqual([
      'Ctrl+Left',
      'Ctrl+Right',
      'Alt+Left',
      'Alt+Right',
      'Ctrl+Backspace',
    ])
    expect(terminalKeymapKeys('none', 'linux')).toEqual({})
    expect(Object.keys(terminalKeymapKeys('ostia', 'mac'))).toHaveLength(8)
  })
})
