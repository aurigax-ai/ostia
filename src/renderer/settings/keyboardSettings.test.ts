import { describe, expect, it } from 'vitest'
import { readKeyboard, writeKeyboard } from './keyboardSettings'

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value))

const linuxFile = {
  keymap: { linux: 'ostia' },
  keybindings: { linux: { 'palette.toggle': 'Ctrl+Shift+Y' } },
  terminalKeys: { linux: { 'Ctrl+Alt+K': { type: 'escape', value: 'k' } } },
}

describe('readKeyboard', () => {
  it('reads the settings of this platform and keeps the other platform’s apart', () => {
    const file = {
      ...linuxFile,
      keymap: { linux: 'ostia', mac: 'keymap-macos/cmux' },
      terminalKeymap: { mac: 'natural-text-editing' },
      keybindings: { ...linuxFile.keybindings, mac: { 'palette.toggle': 'Cmd+Shift+Y' } },
    }
    const onMac = readKeyboard(file, 'mac')
    expect(plain(onMac.current)).toEqual({
      keymap: 'keymap-macos/cmux',
      terminalKeymap: 'natural-text-editing',
      keybindings: { 'palette.toggle': 'Cmd+Shift+Y' },
      terminalKeys: {},
    })
    expect(plain(onMac.elsewhere)).toEqual({
      linux: {
        keymap: 'ostia',
        terminalKeymap: null,
        keybindings: { 'palette.toggle': 'Ctrl+Shift+Y' },
        terminalKeys: { 'Ctrl+Alt+K': { type: 'escape', value: 'k' } },
      },
    })
  })

  it('gives a platform with nothing saved empty settings, so it uses its own default', () => {
    const onMac = readKeyboard(linuxFile, 'mac')
    expect(plain(onMac.current)).toEqual({
      keymap: null,
      terminalKeymap: null,
      keybindings: {},
      terminalKeys: {},
    })
    expect(onMac.elsewhere.linux?.keybindings['palette.toggle']).toBe('Ctrl+Shift+Y')
  })

  it('reads the old format, one keymap and one set of shortcuts, as this platform’s only', () => {
    const old = { keymap: 'keymap-macos/cmux', keybindings: { 'palette.toggle': 'Cmd+Shift+Y' } }
    const onMac = readKeyboard(old, 'mac')
    expect(onMac.current.keymap).toBe('keymap-macos/cmux')
    expect({ ...onMac.current.keybindings }).toEqual({ 'palette.toggle': 'Cmd+Shift+Y' })
    expect(onMac.elsewhere).toEqual({})
    const legacy = { keymap: null, keybindings: { 'view.toggleRail': null } }
    const onLinux = readKeyboard(legacy, 'linux')
    expect(onLinux.current.keymap).toBeNull()
    expect({ ...onLinux.current.keybindings }).toEqual({ 'view.toggleRail': null })
    expect(onLinux.elsewhere).toEqual({})
  })

  it('drops values that do not parse, per platform', () => {
    const file = {
      keymap: { mac: 'Bad/Ref', linux: 7 },
      terminalKeymap: { mac: 'vim' },
      keybindings: { mac: { 'palette.toggle': 'Hyper+Q' } },
    }
    const onMac = readKeyboard(file, 'mac')
    expect(onMac.current.keymap).toBeNull()
    expect(onMac.current.terminalKeymap).toBeNull()
    expect({ ...onMac.current.keybindings }).toEqual({})
    expect(onMac.elsewhere.linux?.keymap).toBeNull()
  })
})

describe('writeKeyboard', () => {
  it('writes this platform’s settings under its name and leaves the other platform as it was', () => {
    const { current, elsewhere } = readKeyboard(linuxFile, 'mac')
    const mac = {
      ...current,
      terminalKeymap: 'none',
      keybindings: { 'palette.toggle': 'Cmd+Shift+Y' },
    }
    expect(plain(writeKeyboard(mac, elsewhere, 'mac'))).toEqual({
      keymap: { linux: 'ostia' },
      terminalKeymap: { mac: 'none' },
      keybindings: {
        mac: { 'palette.toggle': 'Cmd+Shift+Y' },
        linux: { 'palette.toggle': 'Ctrl+Shift+Y' },
      },
      terminalKeys: { linux: { 'Ctrl+Alt+K': { type: 'escape', value: 'k' } } },
    })
  })

  it('turns the old format into this platform’s entry only', () => {
    const { current, elsewhere } = readKeyboard(
      { keymap: 'keymap-macos/cmux', keybindings: { 'palette.toggle': 'Cmd+Shift+Y' } },
      'mac',
    )
    expect(plain(writeKeyboard(current, elsewhere, 'mac'))).toEqual({
      keymap: { mac: 'keymap-macos/cmux' },
      terminalKeymap: {},
      keybindings: { mac: { 'palette.toggle': 'Cmd+Shift+Y' } },
      terminalKeys: {},
    })
  })

  it('round-trips a file with both platforms unchanged, chord lists included', () => {
    const file = {
      keymap: { mac: 'keymap-macos/cmux', linux: 'ostia' },
      terminalKeymap: { mac: 'natural-text-editing', linux: 'none' },
      keybindings: {
        mac: { 'pane.zoom': null, 'tab.next': ['Ctrl+Tab', 'Shift+Cmd+]'] },
        linux: { 'pane.zoom': 'Ctrl+Shift+Z' },
      },
      terminalKeys: { mac: { Delete: null } },
    }
    for (const here of ['mac', 'linux'] as const) {
      const { current, elsewhere } = readKeyboard(file, here)
      expect(plain(writeKeyboard(current, elsewhere, here)), here).toEqual(file)
    }
  })
})
