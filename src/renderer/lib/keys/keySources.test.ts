import {
  CHORDS_PER_COMMAND_MAX,
  type ChordSpec,
  type KeybindingMap,
  formatScopedChord,
  parseScopedChord,
} from '@shared/chordSpec'
import { NATURAL_TEXT_EDITING, NO_TERMINAL_KEYMAP, OSTIA_KEYMAP } from '@shared/keyboardPresets'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CHORDS, effectiveBindings } from './chords'
import {
  COMMAND_GROUPS,
  canAddChord,
  commandGroup,
  commandSources,
  groupRows,
  layerOf,
  overrideFor,
  sameChordSet,
  terminalKeySources,
  withChordAdded,
  withChordRemoved,
  withChordReplaced,
} from './keySources'

const specs = (mac: boolean, ...texts: string[]): ChordSpec[] =>
  texts.map((t) => {
    const spec = parseScopedChord(t, mac)
    if (!spec) throw new Error(`bad chord ${t}`)
    return spec
  })

const texts = (list: readonly ChordSpec[], mac: boolean): string[] =>
  list.map((s) => formatScopedChord(s, mac))

const cmux: KeybindingMap = {
  'palette.toggle': 'Shift+Cmd+P',
  'workspace.goto': 'Cmd+P',
  'view.goToFile': null,
  'workspace.new': 'Cmd+N',
}

describe('layerOf', () => {
  it('tells apart a missing id, an explicit unbind, an ignored value and chords', () => {
    expect(layerOf({}, 'palette.toggle', true)).toBeNull()
    expect(layerOf({ 'palette.toggle': null }, 'palette.toggle', true)).toBe('unbound')
    expect(layerOf({ 'palette.toggle': 'Ctrl+R' }, 'palette.toggle', false)).toBeNull()
    const layer = layerOf({ 'palette.toggle': ['Cmd+K', 'Cmd+K'] }, 'palette.toggle', true)
    expect(layer).not.toBe('unbound')
    expect(texts(layer as ChordSpec[], true)).toEqual(['Cmd+K'])
  })

  it('ignores ids inherited from the prototype', () => {
    expect(layerOf({}, 'toString', true)).toBeNull()
  })
})

describe('commandSources', () => {
  it('reports an untouched command as the Ostia default with no label', () => {
    const s = commandSources('palette.toggle', {}, {}, true)
    expect(s.source).toBe('default')
    expect(s.label).toBeNull()
    expect(s.preset).toBeNull()
    expect(s.user).toBeNull()
    expect(texts(s.effective, true)).toEqual(texts(s.ostia, true))
    expect(s.ostia).toHaveLength(2)
    expect(s.dropped).toEqual([])
  })

  it('labels a preset that drops a second chord and names the dropped chord', () => {
    const s = commandSources('palette.toggle', {}, cmux, true)
    expect(s.source).toBe('preset')
    expect(s.label).toBe('preset')
    expect(texts(s.effective, true)).toEqual(texts(specs(true, 'Shift+Cmd+P'), true))
    expect(texts(s.dropped, true)).toEqual(texts(specs(true, 'Cmd+K'), true))
  })

  it('leaves a preset value equal to the Ostia default unlabelled', () => {
    const s = commandSources('workspace.new', {}, cmux, true)
    expect(s.source).toBe('preset')
    expect(s.label).toBeNull()
  })

  it('labels a preset unbind and lists every Ostia chord as dropped', () => {
    const s = commandSources('view.goToFile', {}, cmux, true)
    expect(s.preset).toBe('unbound')
    expect(s.effective).toEqual([])
    expect(s.label).toBe('preset')
    expect(texts(s.dropped, true)).toEqual(texts(specs(true, 'Cmd+P'), true))
  })

  it('puts the user layer on top of the preset, even an unbind', () => {
    const over = commandSources('palette.toggle', { 'palette.toggle': 'Cmd+Shift+Y' }, cmux, true)
    expect(over.source).toBe('user')
    expect(over.label).toBe('user')
    expect(texts(over.effective, true)).toEqual(texts(specs(true, 'Cmd+Shift+Y'), true))
    const off = commandSources('view.goToFile', { 'view.goToFile': null }, {}, true)
    expect(off.user).toBe('unbound')
    expect(off.effective).toEqual([])
    expect(off.label).toBe('user')
  })

  it('falls through a user value this computer ignores', () => {
    const s = commandSources('palette.toggle', { 'palette.toggle': 'Ctrl+R' }, cmux, false)
    expect(s.source).toBe('preset')
  })

  it('agrees with effectiveBindings for every default command', () => {
    const user: KeybindingMap = {
      'tab.new': 'Cmd+Alt+T',
      'view.goToFile': 'Cmd+Shift+O',
      'pane.zoom': null,
    }
    for (const mac of [true, false]) {
      const table = effectiveBindings(user, mac, cmux)
      for (const id of Object.keys(DEFAULT_CHORDS)) {
        const effective = commandSources(id, user, cmux, mac).effective
        expect(texts(effective, mac), `${id} on ${mac ? 'mac' : 'linux'}`).toEqual(
          texts(table.byId.get(id) ?? [], mac),
        )
      }
    }
  })
})

describe('chord list edits', () => {
  const zoom = specs(false, 'terminal:Ctrl+Shift+Enter', 'Ctrl+Shift+X')
  const altZ = specs(false, 'Ctrl+Alt+Z')[0]

  it('replaces only the chord at the index and keeps its terminal scope', () => {
    expect(withChordReplaced(zoom, 0, altZ, false)).toEqual(['terminal:Ctrl+Alt+Z', 'Ctrl+Shift+X'])
    expect(withChordReplaced(zoom, 1, altZ, false)).toEqual([
      'terminal:Ctrl+Shift+Enter',
      'Ctrl+Alt+Z',
    ])
  })

  it('drops a duplicate when the new chord equals another chord of the command', () => {
    const x = specs(false, 'Ctrl+Shift+X')[0]
    const both = specs(false, 'Ctrl+Shift+Y', 'Ctrl+Shift+X')
    expect(withChordReplaced(both, 0, x, false)).toEqual(['Ctrl+Shift+X'])
  })

  it('ignores an index outside the list', () => {
    expect(withChordReplaced(zoom, 5, altZ, false)).toEqual(texts(zoom, false))
  })

  it('removes only the chord at the index, down to none', () => {
    expect(withChordRemoved(zoom, 1, false)).toEqual(['terminal:Ctrl+Shift+Enter'])
    expect(
      withChordRemoved(
        withChordRemoved(zoom, 1, false).map((t) => specs(false, t)[0]),
        0,
        false,
      ),
    ).toEqual([])
  })

  it('adds a chord at the end, skips a duplicate and stops at the limit', () => {
    expect(withChordAdded(zoom, altZ, false)).toEqual([...texts(zoom, false), 'Ctrl+Alt+Z'])
    expect(withChordAdded(zoom, zoom[1], false)).toEqual(texts(zoom, false))
    const full = Array.from(
      { length: CHORDS_PER_COMMAND_MAX },
      (_, i) => specs(false, `Ctrl+Alt+F${i + 1}`)[0],
    )
    expect(canAddChord(full)).toBe(false)
    expect(canAddChord(zoom)).toBe(true)
    expect(withChordAdded(full, altZ, false)).toHaveLength(CHORDS_PER_COMMAND_MAX)
  })
})

describe('overrideFor', () => {
  const base = specs(true, 'Shift+Cmd+P', 'Cmd+K')

  it('resets when the list matches the base in any order', () => {
    expect(overrideFor(['Cmd+K', 'Shift+Cmd+P'], base, true)).toEqual({ reset: true })
  })

  it('stores one chord as a string, several as a list and none as an unbind', () => {
    expect(overrideFor(['Shift+Cmd+P'], base, true)).toEqual({ reset: false, value: 'Shift+Cmd+P' })
    expect(overrideFor(['Cmd+K', 'Cmd+J'], base, true)).toEqual({
      reset: false,
      value: ['Cmd+K', 'Cmd+J'],
    })
    expect(overrideFor([], base, true)).toEqual({ reset: false, value: null })
  })

  it('resets an empty list when the base has no chord either', () => {
    expect(overrideFor([], [], true)).toEqual({ reset: true })
  })

  it('compares chords and scope together', () => {
    expect(sameChordSet(specs(true, 'terminal:Cmd+D'), specs(true, 'Cmd+D'))).toBe(false)
  })
})

describe('terminalKeySources', () => {
  it('marks every key of the default preset as default', () => {
    const rows = terminalKeySources({}, null, true)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.source === 'default' && r.label === null)).toBe(true)
    expect(terminalKeySources({}, OSTIA_KEYMAP, true).every((r) => r.label === null)).toBe(true)
  })

  it('labels only the keys Natural Text Editing changes', () => {
    const rows = terminalKeySources({}, NATURAL_TEXT_EDITING, true)
    const labelled = rows.filter((r) => r.label === 'preset').map((r) => r.row.signature)
    expect(labelled).toEqual(['Delete'])
    const lineStart = rows.find((r) => r.row.signature === 'Cmd+Left')
    expect(lineStart).toMatchObject({ source: 'preset', label: null })
  })

  it('labels a user key as custom and keeps the Ostia value beside it', () => {
    const rows = terminalKeySources({ 'Cmd+Left': { type: 'hex', value: '0x02' } }, null, true)
    const row = rows.find((r) => r.row.signature === 'Cmd+Left')
    expect(row).toMatchObject({
      source: 'user',
      label: 'user',
      ostia: { type: 'hex', value: '0x01' },
    })
  })

  it('lists nothing for No translation, and a custom key there is still custom', () => {
    expect(terminalKeySources({}, NO_TERMINAL_KEYMAP, true)).toEqual([])
    const rows = terminalKeySources(
      { 'Ctrl+Alt+K': { type: 'text', value: 'x' } },
      NO_TERMINAL_KEYMAP,
      false,
    )
    expect(rows.map((r) => r.label)).toEqual(['user'])
  })
})

describe('commandGroup', () => {
  it('groups built-in chords by what they act on', () => {
    expect(commandGroup('workspace.new')).toBe('workspace')
    expect(commandGroup('tab.next')).toBe('workspace')
    expect(commandGroup('window.new')).toBe('workspace')
    expect(commandGroup('pane.zoom')).toBe('pane')
    expect(commandGroup('copy')).toBe('terminal')
    expect(commandGroup('terminal.clear')).toBe('terminal')
    expect(commandGroup('view.zoomIn')).toBe('view')
    expect(commandGroup('palette.toggle')).toBe('app')
    expect(commandGroup('browser.reload')).toBe('browser')
  })

  it('falls back to the registered category, then Other', () => {
    expect(commandGroup('keys.splitAll', 'Pane')).toBe('pane')
    expect(commandGroup('keys.hello', '哈囉')).toBe('other')
    expect(commandGroup('keys.hello')).toBe('other')
  })

  it('gives every default chord a group other than Other', () => {
    for (const id of Object.keys(DEFAULT_CHORDS)) expect(commandGroup(id), id).not.toBe('other')
  })

  it('orders groups by the fixed list and drops empty ones, keeping row order', () => {
    const rows = [
      { id: 'b', group: 'pane' as const },
      { id: 'a', group: 'workspace' as const },
      { id: 'c', group: 'pane' as const },
    ]
    const grouped = groupRows(rows)
    expect(grouped.map((g) => g.group)).toEqual(['workspace', 'pane'])
    expect(grouped[1].rows.map((r) => r.id)).toEqual(['b', 'c'])
    expect(COMMAND_GROUPS.indexOf('workspace')).toBeLessThan(COMMAND_GROUPS.indexOf('pane'))
  })
})
