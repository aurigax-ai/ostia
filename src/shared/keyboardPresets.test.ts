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
  it('picks the Ostia presets on macOS and leaves Linux keys untranslated', () => {
    expect(defaultPresetFor({ platform: 'darwin' })).toEqual({ app: 'ostia', terminal: 'ostia' })
    expect(defaultPresetFor({ platform: 'linux' })).toEqual({ app: 'ostia', terminal: 'none' })
    expect(defaultPresetFor({ platform: 'linux', desktop: 'GNOME' })).toEqual({
      app: 'ostia',
      terminal: 'none',
    })
  })

  it('treats anything that is not macOS as Linux', () => {
    expect(keyboardPlatform('darwin')).toBe('mac')
    expect(keyboardPlatform('linux')).toBe('linux')
    expect(keyboardPlatform('freebsd')).toBe('linux')
  })

  it('uses a desktop row when the table has one, matching any part of XDG_CURRENT_DESKTOP', () => {
    const table = {
      ...PLATFORM_DEFAULTS,
      linux: { app: 'ostia', terminal: 'none', desktops: { kde: { app: 'kde', terminal: 'kde' } } },
    }
    expect(defaultPresetFor({ platform: 'linux', desktop: 'KDE' }, table)).toEqual({
      app: 'kde',
      terminal: 'kde',
    })
    expect(defaultPresetFor({ platform: 'linux', desktop: 'ubuntu:KDE' }, table).app).toBe('kde')
    expect(defaultPresetFor({ platform: 'linux', desktop: 'GNOME' }, table).app).toBe('ostia')
    expect(defaultPresetFor({ platform: 'linux', desktop: null }, table).app).toBe('ostia')
    expect(defaultPresetFor({ platform: 'darwin', desktop: 'KDE' }, table).app).toBe('ostia')
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

  it('list only what a platform has: Linux gets No translation and no macOS text keys', () => {
    expect(terminalKeymapsFor('mac').map((k) => k.id)).toEqual([
      'ostia',
      'natural-text-editing',
      'none',
    ])
    expect(terminalKeymapsFor('linux').map((k) => k.id)).toEqual(['none'])
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
    expect(terminalKeymapIn('natural-text-editing', { platform: 'linux' })).toBe('none')
    expect(terminalKeymapIn(null, { platform: 'darwin' })).toBe('ostia')
    expect(terminalKeymapIn('gone', { platform: 'darwin' })).toBe('ostia')
    expect(appKeymapIn(null, { platform: 'linux' })).toBe('ostia')
    expect(appKeymapIn('keymap-macos/cmux', { platform: 'darwin' })).toBe('keymap-macos/cmux')
    expect(terminalKeymapKeys('ostia', 'linux')).toEqual({})
    expect(Object.keys(terminalKeymapKeys('ostia', 'mac'))).toHaveLength(8)
  })
})
