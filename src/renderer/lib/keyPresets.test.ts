import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ChordSpec, type KeyLike, parseChord } from '@shared/chordSpec'
import {
  NATURAL_TEXT_EDITING,
  NATURAL_TEXT_EDITING_KEYS,
  NO_TERMINAL_KEYMAP,
  OSTIA_TERMINAL_KEYS,
} from '@shared/keyboardPresets'
import { parseKeymapBindings } from '@shared/keymapFile'
import { afterEach, describe, expect, it } from 'vitest'
import { useKeymapStore } from '../stores/keymapStore'
import { useSettingsStore } from '../stores/settingsStore'
import { matchChord, matchChordInTerminal } from './chords'
import {
  currentTerminalKeys,
  presetKeys,
  removeTerminalKey,
  resetTerminalKey,
  saveTerminalKey,
  terminalKeyData,
  terminalKeyTable,
} from './keyPresets'

const initialSettings = useSettingsStore.getState()
const initialKeymap = useKeymapStore.getState()

afterEach(() => {
  useSettingsStore.setState(initialSettings, true)
  useKeymapStore.setState(initialKeymap, true)
})

type Mods = Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>>

const key = (k: string, mods: Mods = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
})

const cmd = { metaKey: true }
const opt = { altKey: true }

const chord = (text: string, mac = true): ChordSpec => {
  const spec = parseChord(text, mac)
  if (!spec) throw new Error(`not a chord: ${text}`)
  return spec
}

const OSTIA_SENDS: [string, KeyLike, string][] = [
  ['⌘⌫', key('Backspace', cmd), '\x15'],
  ['⌘←', key('ArrowLeft', cmd), '\x01'],
  ['⌘→', key('ArrowRight', cmd), '\x05'],
  ['⌥←', key('ArrowLeft', opt), '\x1bb'],
  ['⌥→', key('ArrowRight', opt), '\x1bf'],
  ['⌥⌫', key('Backspace', opt), '\x1b\x7f'],
  ['⌥⌦', key('Delete', opt), '\x1bd'],
  ['⌘⌦', key('Delete', cmd), '\x0b'],
]

const LINUX_SENDS: [string, KeyLike, string][] = [
  ['Ctrl+Left', key('ArrowLeft', { ctrlKey: true }), '\x1bb'],
  ['Ctrl+Right', key('ArrowRight', { ctrlKey: true }), '\x1bf'],
  ['Alt+Left', key('ArrowLeft', opt), '\x1bb'],
  ['Alt+Right', key('ArrowRight', opt), '\x1bf'],
  ['Ctrl+Backspace', key('Backspace', { ctrlKey: true }), '\x17'],
]

const NATURAL_SENDS: [string, KeyLike, string][] = [
  ['⌥⌫', key('Backspace', opt), '\x1b\x7f'],
  ['⌥←', key('ArrowLeft', opt), '\x1bb'],
  ['⌥→', key('ArrowRight', opt), '\x1bf'],
  ['⌥⌦', key('Delete', opt), '\x1bd'],
  ['⌘⌫', key('Backspace', cmd), '\x15'],
  ['⌘←', key('ArrowLeft', cmd), '\x01'],
  ['⌘→', key('ArrowRight', cmd), '\x05'],
  ['⌦', key('Delete'), '\x04'],
]

describe('Ostia default preset', () => {
  it('is what a Mac without settings gets: every key sends its sequence', () => {
    expect(useSettingsStore.getState().keymap).toBeNull()
    for (const [name, event, sent] of OSTIA_SENDS) {
      expect(terminalKeyData(event, true), name).toBe(sent)
    }
    expect(currentTerminalKeys(true).rows).toHaveLength(Object.keys(OSTIA_TERMINAL_KEYS).length)
    expect(Object.keys(OSTIA_TERMINAL_KEYS)).toHaveLength(OSTIA_SENDS.length)
  })

  it('keeps the five keys macOS had before, byte for byte, which are also Ghostty’s defaults', () => {
    expect(terminalKeyData(key('Backspace', cmd), true)).toBe('\x15')
    expect(terminalKeyData(key('ArrowLeft', cmd), true)).toBe('\x01')
    expect(terminalKeyData(key('ArrowRight', cmd), true)).toBe('\x05')
    expect(terminalKeyData(key('ArrowLeft', opt), true)).toBe('\x1bb')
    expect(terminalKeyData(key('ArrowRight', opt), true)).toBe('\x1bf')
  })

  it('still sends Option+arrows when Option is the Meta key', () => {
    useSettingsStore.setState((s) => ({ terminal: { ...s.terminal, macOptionIsMeta: true } }))
    expect(terminalKeyData(key('ArrowLeft', opt), true)).toBe('\x1bb')
    expect(terminalKeyData(key('ArrowRight', opt), true)).toBe('\x1bf')
  })

  it('leaves other keys and other modifier mixes to the terminal', () => {
    for (const event of [
      key('Backspace'),
      key('Delete'),
      key('ArrowLeft'),
      key('k', cmd),
      key('ArrowUp', opt),
      key('ArrowLeft', { metaKey: true, shiftKey: true }),
      key('ArrowLeft', { altKey: true, shiftKey: true }),
      key('ArrowLeft', { metaKey: true, ctrlKey: true }),
      key('ArrowLeft', { metaKey: true, altKey: true }),
      key('Backspace', { metaKey: true, altKey: true }),
    ]) {
      expect(terminalKeyData(event, true), JSON.stringify(event)).toBeNull()
    }
  })

  it('gives Linux the Ostia standard keys by default: word moves and Ctrl+Backspace', () => {
    expect(useSettingsStore.getState().terminalKeymap).toBeNull()
    for (const [name, event, sent] of LINUX_SENDS) {
      expect(terminalKeyData(event, false), name).toBe(sent)
    }
    expect(currentTerminalKeys(false).rows).toHaveLength(LINUX_SENDS.length)
    expect(presetKeys(NATURAL_TEXT_EDITING, false)).toEqual(presetKeys(null, false))
  })

  it('leaves every other key on Linux to the terminal, macOS keys included', () => {
    for (const [name, event] of [...OSTIA_SENDS, ...NATURAL_SENDS]) {
      if (event.altKey && !event.metaKey && event.key.startsWith('Arrow')) continue
      expect(terminalKeyData(event, false), name).toBeNull()
    }
    for (const event of [
      key('ArrowUp', { ctrlKey: true }),
      key('ArrowLeft', { ctrlKey: true, shiftKey: true }),
      key('ArrowLeft', { ctrlKey: true, altKey: true }),
      key('Backspace', { altKey: true }),
      key('Delete', { ctrlKey: true }),
      key('Home'),
      key('End'),
    ]) {
      expect(terminalKeyData(event, false), JSON.stringify(event)).toBeNull()
    }
  })

  it('sends nothing on Linux with No translation, as before', () => {
    useSettingsStore.setState({ terminalKeymap: NO_TERMINAL_KEYMAP })
    for (const [name, event] of LINUX_SENDS) expect(terminalKeyData(event, false), name).toBeNull()
    expect(currentTerminalKeys(false).rows).toEqual([])
  })

  it('sends Alt+arrows to the shell in a terminal although they go back and forward in a browser', () => {
    expect(matchChord(key('ArrowLeft', opt), false)).toBe('browser.back')
    expect(matchChord(key('ArrowRight', opt), false)).toBe('browser.forward')
    expect(terminalKeyData(key('ArrowLeft', opt), false)).toBe('\x1bb')
    expect(terminalKeyData(key('ArrowRight', opt), false)).toBe('\x1bf')
  })

  it('sends nothing with No translation, for shells in vi mode', () => {
    useSettingsStore.setState({ terminalKeymap: NO_TERMINAL_KEYMAP })
    for (const [name, event] of OSTIA_SENDS) expect(terminalKeyData(event, true), name).toBeNull()
    expect(currentTerminalKeys(true).rows).toEqual([])
  })

  it('falls back to the platform default for a text editing preset the platform lacks', () => {
    useSettingsStore.setState({ terminalKeymap: 'gone' })
    expect(terminalKeyData(key('ArrowLeft', cmd), true)).toBe('\x01')
  })
})

describe('Natural Text Editing preset', () => {
  it('sends exactly the eight keys of iTerm2’s preset', () => {
    useSettingsStore.setState({ terminalKeymap: NATURAL_TEXT_EDITING })
    for (const [name, event, sent] of NATURAL_SENDS) {
      expect(terminalKeyData(event, true), name).toBe(sent)
    }
    expect(Object.keys(NATURAL_TEXT_EDITING_KEYS)).toHaveLength(NATURAL_SENDS.length)
    expect(currentTerminalKeys(true).rows).toHaveLength(NATURAL_SENDS.length)
  })

  it('has no Cmd+Forward Delete, as in iTerm2', () => {
    useSettingsStore.setState({ terminalKeymap: NATURAL_TEXT_EDITING })
    expect(terminalKeyData(key('Delete', cmd), true)).toBeNull()
  })
})

describe('macOS (cmux) preset', () => {
  const cmux = JSON.parse(
    readFileSync(join(__dirname, '../../extensions/keymap-macos/assets/cmux.json'), 'utf8'),
  )

  it('changes the command chords and keeps the Ostia default terminal keys', () => {
    const parsed = parseKeymapBindings(cmux, true)
    if (!parsed.ok) throw new Error(parsed.error)
    useSettingsStore.setState({ keymap: 'keymap-macos/cmux' })
    useKeymapStore.setState({
      key: 'keymap-macos/cmux\n1.0.0',
      ref: 'keymap-macos/cmux',
      error: null,
      loaded: {
        extId: 'keymap-macos',
        id: 'cmux',
        label: 'macOS (cmux)',
        bindings: parsed.bindings,
        skipped: [],
      },
    })
    expect(matchChordInTerminal(key('ArrowLeft', { metaKey: true, altKey: true }), true)).toBe(
      'pane.focusLeft',
    )
    for (const [name, event, sent] of OSTIA_SENDS) {
      expect(terminalKeyData(event, true), name).toBe(sent)
    }
  })
})

describe('user terminal keys on top of the preset', () => {
  it('override a preset key, drop one with null and add new ones', () => {
    useSettingsStore.setState({
      terminalKeys: {
        'Cmd+Left': { type: 'text', value: '\\x1bOH' },
        'Alt+Delete': null,
        'Cmd+Y': { type: 'text', value: 'clear\\r' },
      },
    })
    expect(terminalKeyData(key('ArrowLeft', cmd), true)).toBe('\x1bOH')
    expect(terminalKeyData(key('Delete', opt), true)).toBeNull()
    expect(terminalKeyData(key('y', cmd), true)).toBe('clear\r')
    expect(terminalKeyData(key('ArrowRight', cmd), true)).toBe('\x05')
  })

  it('match the preset key however the chord is spelled', () => {
    useSettingsStore.setState({ terminalKeys: { 'Option+Left': { type: 'hex', value: '0x02' } } })
    const table = currentTerminalKeys(true)
    expect(table.rows.filter((r) => r.signature === 'Alt+Left')).toHaveLength(1)
    expect(terminalKeyData(key('ArrowLeft', opt), true)).toBe('\x02')
  })

  it('override the Natural Text Editing preset the same way', () => {
    useSettingsStore.setState({
      terminalKeymap: NATURAL_TEXT_EDITING,
      terminalKeys: { Delete: null, 'Cmd+Delete': { type: 'hex', value: '0x0b' } },
    })
    expect(terminalKeyData(key('Delete'), true)).toBeNull()
    expect(terminalKeyData(key('Delete', cmd), true)).toBe('\x0b')
  })

  it('skip keys that would type and values that do not decode', () => {
    const table = terminalKeyTable(
      {
        a: { type: 'text', value: 'x' },
        'Cmd+J': { type: 'hex', value: '0x80' },
        'Ctrl+Shift+K': { type: 'escape', value: 'k' },
      },
      NO_TERMINAL_KEYMAP,
      false,
    )
    expect(table.rows.map((r) => r.signature)).toEqual(['Ctrl+Shift+K'])
  })

  it('work on Linux too, on top of its own preset', () => {
    useSettingsStore.setState({
      terminalKeys: { 'Ctrl+Shift+Y': { type: 'escape', value: 'y' }, 'Ctrl+Backspace': null },
    })
    expect(terminalKeyData(key('Y', { ctrlKey: true, shiftKey: true }), false)).toBe('\x1by')
    expect(terminalKeyData(key('Backspace', { ctrlKey: true }), false)).toBeNull()
    expect(terminalKeyData(key('ArrowLeft', { ctrlKey: true }), false)).toBe('\x1bb')
    expect(terminalKeyData(key('ArrowLeft', cmd), false)).toBeNull()
  })
})

describe('a command and a terminal key on the same chord', () => {
  it('runs the command and sends nothing', () => {
    useSettingsStore.setState({ keybindings: { 'tab.previous': 'Cmd+Left' } })
    expect(matchChord(key('ArrowLeft', cmd), true)).toBe('tab.previous')
    expect(terminalKeyData(key('ArrowLeft', cmd), true)).toBeNull()
    expect(terminalKeyData(key('ArrowRight', cmd), true)).toBe('\x05')
  })

  it('lets the terminal key through once the command is unbound', () => {
    useSettingsStore.setState({
      keybindings: { 'block.selectPrev': null },
      terminalKeys: { 'Cmd+Up': { type: 'escape', value: '[A' } },
    })
    expect(matchChord(key('ArrowUp', cmd), true)).toBeNull()
    expect(terminalKeyData(key('ArrowUp', cmd), true)).toBe('\x1b[A')
  })

  it('keeps the default command when a terminal key is set on its chord by hand', () => {
    useSettingsStore.setState({ terminalKeys: { 'Cmd+Up': { type: 'escape', value: '[A' } } })
    expect(matchChord(key('ArrowUp', cmd), true)).toBe('block.selectPrev')
    expect(terminalKeyData(key('ArrowUp', cmd), true)).toBeNull()
  })
})

describe('editing terminal keys', () => {
  const rowFor = (signature: string) => {
    const row = currentTerminalKeys(true).bySignature.get(signature)
    if (!row) throw new Error(`no row ${signature}`)
    return row
  }

  it('saves a new key, and saving a preset key back to its value removes the override', () => {
    saveTerminalKey(chord('Cmd+Y'), { type: 'text', value: 'clear\\r' }, null, true)
    expect(useSettingsStore.getState().terminalKeys).toEqual({
      'Cmd+Y': { type: 'text', value: 'clear\\r' },
    })
    const left = rowFor('Cmd+Left')
    saveTerminalKey(chord('Cmd+Left'), { type: 'hex', value: '0x02' }, left, true)
    expect(useSettingsStore.getState().terminalKeys['Cmd+Left']).toEqual({
      type: 'hex',
      value: '0x02',
    })
    saveTerminalKey(chord('Cmd+Left'), { type: 'hex', value: '0x01' }, rowFor('Cmd+Left'), true)
    expect(useSettingsStore.getState().terminalKeys).not.toHaveProperty('Cmd+Left')
    expect(terminalKeyData(key('ArrowLeft', cmd), true)).toBe('\x01')
  })

  it('moving a preset key to another chord drops it from the old chord', () => {
    saveTerminalKey(chord('Cmd+I'), { type: 'hex', value: '0x15' }, rowFor('Cmd+Backspace'), true)
    expect(useSettingsStore.getState().terminalKeys).toEqual({
      'Cmd+Backspace': null,
      'Cmd+I': { type: 'hex', value: '0x15' },
    })
    expect(terminalKeyData(key('Backspace', cmd), true)).toBeNull()
    expect(terminalKeyData(key('i', cmd), true)).toBe('\x15')
  })

  it('removes a preset key with null and a user key outright, and resets an override', () => {
    useSettingsStore.setState({
      terminalKeys: {
        'Option+Left': { type: 'hex', value: '0x02' },
        'Cmd+Y': { type: 'text', value: 'ls\\r' },
      },
    })
    resetTerminalKey(rowFor('Alt+Left'), true)
    expect(useSettingsStore.getState().terminalKeys).toEqual({
      'Cmd+Y': { type: 'text', value: 'ls\\r' },
    })
    expect(terminalKeyData(key('ArrowLeft', opt), true)).toBe('\x1bb')
    removeTerminalKey(rowFor('Cmd+Y'), true)
    removeTerminalKey(rowFor('Alt+Right'), true)
    expect(useSettingsStore.getState().terminalKeys).toEqual({ 'Alt+Right': null })
    expect(terminalKeyData(key('ArrowRight', opt), true)).toBeNull()
  })
})
