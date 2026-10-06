import { describe, expect, it } from 'vitest'
import { parseChord } from './chordSpec'
import {
  APP_KEYMAPS,
  KEYBOARD_PLATFORMS,
  PLATFORM_DEFAULTS,
  TERMINAL_KEYMAPS,
  appKeymapIn,
  appKeymapsFor,
  defaultPresetFor,
  keyboardPlatform,
  terminalKeymapIn,
  terminalKeymapKeys,
  terminalKeymapsFor,
} from './keyboardPresets'
import { sendData } from './terminalKeys'

describe('defaultPresetFor', () => {
  it('picks Ostia and Ostia standard on both platforms, by the OS alone', () => {
    expect(defaultPresetFor({ platform: 'darwin' })).toEqual({ app: 'ostia', terminal: 'ostia' })
    expect(defaultPresetFor({ platform: 'linux' })).toEqual({ app: 'ostia', terminal: 'ostia' })
  })

  it('treats anything that is not macOS as Linux', () => {
    expect(keyboardPlatform('darwin')).toBe('mac')
    expect(keyboardPlatform('linux')).toBe('linux')
    expect(keyboardPlatform('freebsd')).toBe('linux')
    expect(defaultPresetFor({ platform: 'freebsd' })).toBe(PLATFORM_DEFAULTS.linux)
  })
})

describe('preset tables', () => {
  it('offer each platform’s default on that platform', () => {
    for (const platform of KEYBOARD_PLATFORMS) {
      const { app, terminal } = PLATFORM_DEFAULTS[platform]
      const apps = appKeymapsFor(platform).map((k) => k.id)
      const terminals = terminalKeymapsFor(platform).map((k) => k.id)
      expect(apps, platform).toContain(app)
      expect(terminals, platform).toContain(terminal)
    }
  })

  it('list only what a platform has: Natural Text Editing is macOS only', () => {
    expect(terminalKeymapsFor('mac').map((k) => k.id)).toEqual([
      'ostia',
      'natural-text-editing',
      'none',
    ])
    expect(terminalKeymapsFor('linux').map((k) => k.id)).toEqual(['ostia', 'none'])
    expect(appKeymapsFor('linux').map((k) => k.id)).toEqual(['ostia'])
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
    expect(new Set(APP_KEYMAPS.map((k) => k.id)).size).toBe(APP_KEYMAPS.length)
  })

  it('resolve a choice the platform lacks, or none, to the platform default', () => {
    expect(terminalKeymapIn('natural-text-editing', { platform: 'darwin' })).toBe(
      'natural-text-editing',
    )
    expect(terminalKeymapIn('natural-text-editing', { platform: 'linux' })).toBe('ostia')
    expect(terminalKeymapIn('none', { platform: 'linux' })).toBe('none')
    expect(terminalKeymapIn(null, { platform: 'darwin' })).toBe('ostia')
    expect(terminalKeymapIn('gone', { platform: 'darwin' })).toBe('ostia')
    expect(appKeymapIn(null, { platform: 'linux' })).toBe('ostia')
    expect(appKeymapIn('keymap-macos/cmux', { platform: 'darwin' })).toBe('keymap-macos/cmux')
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
