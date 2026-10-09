import {
  NATURAL_TEXT_EDITING,
  NO_TERMINAL_KEYMAP,
  OSTIA_KEYMAP,
} from '@shared/keyboard/keyboardPresets'
import { describe, expect, it } from 'vitest'
import {
  appPresetChanges,
  appPreview,
  presetSendFor,
  textPresetChanges,
  textPreview,
  userChangeCount,
  userChanges,
} from './keyChanges'

describe('userChanges', () => {
  it('splits your own layer into custom and removed, for commands and text editing keys', () => {
    const changes = userChanges(
      { 'palette.toggle': 'Ctrl+Shift+Y', 'view.toggleRail': null },
      { 'Ctrl+Alt+K': { type: 'text', value: 'k' }, 'Alt+Left': null },
    )
    expect(changes.customCommands).toEqual([{ id: 'palette.toggle', value: 'Ctrl+Shift+Y' }])
    expect(changes.removedCommands).toEqual([{ id: 'view.toggleRail', value: null }])
    expect(changes.customKeys).toEqual([{ keys: 'Ctrl+Alt+K', send: { type: 'text', value: 'k' } }])
    expect(changes.removedKeys).toEqual([{ keys: 'Alt+Left', send: null }])
    expect(userChangeCount(changes)).toBe(4)
  })

  it('counts nothing for a clean setup', () => {
    expect(userChangeCount(userChanges({}, {}))).toBe(0)
  })
})

describe('preset changes against Ostia', () => {
  it('lists what an app keymap changes compared with the Ostia defaults', () => {
    const changes = appPresetChanges(
      { 'palette.toggle': 'Ctrl+Alt+P', 'view.toggleRail': null, 'tab.new': 'Ctrl+Shift+T' },
      false,
    )
    expect(changes.map((c) => c.id).sort()).toEqual(['palette.toggle', 'view.toggleRail'])
    expect(changes.find((c) => c.id === 'view.toggleRail')).toMatchObject({
      before: 'Ctrl+Shift+B',
      after: null,
    })
  })

  it('lists nothing for the Ostia text editing keys and every key for No translation', () => {
    expect(textPresetChanges(null, true)).toEqual([])
    expect(textPresetChanges(OSTIA_KEYMAP, false)).toEqual([])
    const none = textPresetChanges(NO_TERMINAL_KEYMAP, true)
    expect(none.length).toBeGreaterThan(0)
    expect(none.every((c) => c.after === null)).toBe(true)
  })

  it('lists the two keys Natural Text Editing changes on macOS', () => {
    const changes = textPresetChanges(NATURAL_TEXT_EDITING, true)
    expect(changes.map((c) => c.keys).sort()).toEqual(['Delete', '⌘Delete'])
  })
})

describe('presetSendFor', () => {
  it('finds what the chosen preset sends for a key however it is spelled', () => {
    expect(presetSendFor('Cmd+Left', null, true)).toEqual({ type: 'hex', value: '0x01' })
    expect(presetSendFor('Ctrl+Alt+K', null, true)).toBeNull()
    expect(presetSendFor('not a key', null, true)).toBeNull()
  })
})

describe('preview plans', () => {
  it('marks the app changes your own setting keeps on top', () => {
    const plan = appPreview(
      {},
      { 'palette.toggle': 'Ctrl+Alt+P', 'view.toggleRail': null },
      { 'palette.toggle': 'Ctrl+Shift+Y' },
      false,
    )
    expect(plan.changes).toHaveLength(2)
    expect(plan.keptCustom.map((c) => c.id)).toEqual(['palette.toggle'])
  })

  it('previews nothing when switching to the keymap already in use', () => {
    const keymap = { 'palette.toggle': 'Ctrl+Alt+P' }
    expect(appPreview(keymap, keymap, {}, false).changes).toEqual([])
    expect(textPreview(OSTIA_KEYMAP, OSTIA_KEYMAP, {}, true).changes).toEqual([])
  })

  it('marks the text editing keys you set yourself, matched by signature', () => {
    const plan = textPreview(
      null,
      NATURAL_TEXT_EDITING,
      { 'Cmd+Delete': { type: 'text', value: 'x' } },
      true,
    )
    expect(plan.changes).toHaveLength(2)
    expect(plan.keptCustom.map((c) => c.keys)).toEqual(['⌘Delete'])
  })
})
