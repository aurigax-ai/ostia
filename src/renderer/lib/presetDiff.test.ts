import {
  NATURAL_TEXT_EDITING_KEYS,
  OSTIA_LINUX_TERMINAL_KEYS,
  OSTIA_TERMINAL_KEYS,
} from '@shared/keyboardPresets'
import { describe, expect, it } from 'vitest'
import { appKeyChanges, sendActionKey, terminalKeyChanges } from './presetDiff'

describe('terminalKeyChanges', () => {
  it('lists keys that differ between two presets on macOS', () => {
    const changes = terminalKeyChanges(OSTIA_TERMINAL_KEYS, NATURAL_TEXT_EDITING_KEYS, true)
    expect(changes.map((c) => c.keys).sort()).toEqual(['Delete', '⌘Delete'])
    expect(changes.find((c) => c.keys === '⌘Delete')).toMatchObject({ after: null })
    expect(changes.find((c) => c.keys === 'Delete')).toMatchObject({ before: null })
  })

  it('reports every key removed when switching to an empty preset', () => {
    const changes = terminalKeyChanges(OSTIA_TERMINAL_KEYS, {}, true)
    expect(changes).toHaveLength(Object.keys(OSTIA_TERMINAL_KEYS).length)
    expect(changes.every((c) => c.after === null && c.before !== null)).toBe(true)
  })

  it('reports nothing for identical presets', () => {
    expect(terminalKeyChanges(OSTIA_LINUX_TERMINAL_KEYS, OSTIA_LINUX_TERMINAL_KEYS, false)).toEqual(
      [],
    )
  })

  it('reports a key whose output changed', () => {
    const changes = terminalKeyChanges(
      { 'Alt+Left': { type: 'escape', value: 'b' } },
      { 'Alt+Left': { type: 'escape', value: 'f' } },
      false,
    )
    expect(changes).toEqual([
      {
        keys: 'Alt+←',
        before: { type: 'escape', value: 'b' },
        after: { type: 'escape', value: 'f' },
      },
    ])
  })
})

describe('appKeyChanges', () => {
  it('shows the keymap chord for a rebound command', () => {
    const changes = appKeyChanges({}, { 'tab.new': 'Ctrl+Shift+Y' }, false)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.id).toBe('tab.new')
    expect(changes[0]?.before).toBe('Ctrl+Shift+T')
    expect(changes[0]?.after).toBe('Ctrl+Shift+Y')
  })

  it('reports nothing when both sides bind the same chords', () => {
    const same = { 'tab.new': 'Ctrl+Shift+Y' }
    expect(appKeyChanges(same, same, false)).toEqual([])
  })
})

describe('sendActionKey', () => {
  it('names the common line editing sends and leaves others unnamed', () => {
    expect(sendActionKey({ type: 'hex', value: '0x01' })).toBe('lineStart')
    expect(sendActionKey({ type: 'escape', value: 'd' })).toBe('deleteWordForward')
    expect(sendActionKey({ type: 'text', value: 'clear\n' })).toBeNull()
  })
})
