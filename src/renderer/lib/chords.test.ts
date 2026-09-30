import { afterEach, describe, expect, it } from 'vitest'
import { commands } from '../commands/registry'
import { useSettingsStore } from '../stores/settingsStore'
import { parseChord } from './chordSpec'
import {
  type KeyLike,
  bindableIds,
  chordLabel,
  conflictsWith,
  effectiveBindings,
  isAppChord,
  matchChord,
  setKeybindingSetting,
  workspaceDigit,
  workspaceIndex,
} from './chords'

const initialSettings = useSettingsStore.getState()

afterEach(() => {
  useSettingsStore.setState(initialSettings, true)
})

const bind = (keybindings: Record<string, string | null>): void =>
  useSettingsStore.setState({ keybindings })

const key = (k: string, mods: Partial<Omit<KeyLike, 'key'>> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('matchChord', () => {
  it('leaves readline Ctrl chords to the shell on Linux/Windows', () => {
    expect(matchChord(key('k', { ctrlKey: true }), false)).toBeNull()
    expect(matchChord(key('\\', { ctrlKey: true }), false)).toBeNull()
    expect(matchChord(key('c', { ctrlKey: true }), false)).toBeNull()
    expect(matchChord(key('v', { ctrlKey: true }), false)).toBeNull()
    expect(matchChord(key('f', { ctrlKey: true }), false)).toBeNull()
  })

  it('maps Ctrl+Shift chords to app and terminal actions on Linux/Windows', () => {
    const cs = { ctrlKey: true, shiftKey: true }
    expect(matchChord(key('P', cs), false)).toBe('palette.toggle')
    expect(matchChord(key('B', cs), false)).toBe('view.toggleRail')
    expect(matchChord(key('C', cs), false)).toBe('copy')
    expect(matchChord(key('V', cs), false)).toBe('paste')
    expect(matchChord(key('F', cs), false)).toBe('find')
    expect(matchChord(key(',', { ctrlKey: true }), false)).toBe('app.openSettings')
  })

  it('maps new workspace to Ctrl+Shift+T and Cmd+T as an app chord, leaving Ctrl+T to the shell', () => {
    const ctrlShiftT = matchChord(key('T', { ctrlKey: true, shiftKey: true }), false)
    const cmdT = matchChord(key('t', { metaKey: true }), true)
    expect(ctrlShiftT).toBe('workspace.new')
    expect(cmdT).toBe('workspace.new')
    expect(isAppChord(ctrlShiftT)).toBe(true)
    expect(matchChord(key('t', { ctrlKey: true }), false)).toBeNull()
    expect(matchChord(key('t', { ctrlKey: true }), true)).toBeNull()
    expect(chordLabel('workspace.new', false)).toBe('Ctrl+Shift+T')
    expect(chordLabel('workspace.new', true)).toBe('⌘T')
  })

  it('maps jump-to-latest-unread to Ctrl+Shift+U and Cmd+Shift+U as an app chord', () => {
    const ctrlShiftU = matchChord(key('U', { ctrlKey: true, shiftKey: true }), false)
    const cmdShiftU = matchChord(key('u', { metaKey: true, shiftKey: true }), true)
    expect(ctrlShiftU).toBe('attention.jumpToLatest')
    expect(cmdShiftU).toBe('attention.jumpToLatest')
    expect(isAppChord(ctrlShiftU)).toBe(true)
    expect(matchChord(key('u', { ctrlKey: true }), false)).toBeNull()
    expect(chordLabel('attention.jumpToLatest', false)).toBe('Ctrl+Shift+U')
    expect(chordLabel('attention.jumpToLatest', true)).toBe('⌘⇧U')
  })

  it('maps send selection to Ctrl+Shift+E and Cmd+Shift+E, leaving Ctrl+E to the shell', () => {
    const ctrlShiftE = matchChord(key('E', { ctrlKey: true, shiftKey: true }), false)
    const cmdShiftE = matchChord(key('e', { metaKey: true, shiftKey: true }), true)
    expect(ctrlShiftE).toBe('selection.sendToAgent')
    expect(cmdShiftE).toBe('selection.sendToAgent')
    expect(isAppChord(ctrlShiftE)).toBe(true)
    expect(matchChord(key('e', { ctrlKey: true }), false)).toBeNull()
    expect(matchChord(key('e', { ctrlKey: true, shiftKey: true }), true)).toBeNull()
    expect(chordLabel('selection.sendToAgent', false)).toBe('Ctrl+Shift+E')
    expect(chordLabel('selection.sendToAgent', true)).toBe('⌘⇧E')
  })

  it('maps bare Cmd chords on macOS and ignores Ctrl there', () => {
    const cmd = { metaKey: true }
    expect(matchChord(key('k', cmd), true)).toBe('palette.toggle')
    expect(matchChord(key('\\', cmd), true)).toBe('view.toggleRail')
    expect(matchChord(key(',', cmd), true)).toBe('app.openSettings')
    expect(matchChord(key('f', cmd), true)).toBe('find')
    expect(matchChord(key('k', { ctrlKey: true }), true)).toBeNull()
    expect(matchChord(key('k', { metaKey: true, shiftKey: true }), true)).toBeNull()
  })

  it('never matches when Alt is held or on unbound keys', () => {
    expect(matchChord(key('P', { ctrlKey: true, shiftKey: true, altKey: true }), false)).toBeNull()
    expect(matchChord(key('z', { ctrlKey: true, shiftKey: true }), false)).toBeNull()
    expect(matchChord(key('p', { metaKey: true, ctrlKey: true }), false)).toBeNull()
  })
})

describe('block chords', () => {
  it('maps Ctrl+Shift+Up/Down and Cmd+Up/Down to terminal-local block navigation', () => {
    const cs = { ctrlKey: true, shiftKey: true }
    expect(matchChord(key('ArrowUp', cs), false)).toBe('block.selectPrev')
    expect(matchChord(key('ArrowDown', cs), false)).toBe('block.selectNext')
    expect(matchChord(key('ArrowUp', { metaKey: true }), true)).toBe('block.selectPrev')
    expect(matchChord(key('ArrowDown', { metaKey: true }), true)).toBe('block.selectNext')
    expect(isAppChord('block.selectPrev')).toBe(false)
  })

  it('leaves plain and Ctrl-only arrows to the shell', () => {
    expect(matchChord(key('ArrowUp', { ctrlKey: true }), false)).toBeNull()
    expect(matchChord(key('ArrowUp', { shiftKey: true }), false)).toBeNull()
    expect(matchChord(key('ArrowUp'), false)).toBeNull()
  })

  it('opens history search with Ctrl+Shift+H or Cmd+Shift+H, never Ctrl+R', () => {
    expect(matchChord(key('H', { ctrlKey: true, shiftKey: true }), false)).toBe('history.search')
    expect(matchChord(key('h', { metaKey: true, shiftKey: true }), true)).toBe('history.search')
    expect(matchChord(key('r', { ctrlKey: true }), false)).toBeNull()
    expect(isAppChord('history.search')).toBe(true)
    expect(chordLabel('block.selectPrev', false)).toBe('Ctrl+Shift+↑')
    expect(chordLabel('history.search', true)).toBe('⌘⇧H')
  })
})

describe('isAppChord', () => {
  it('separates app-level chords from terminal-local ones', () => {
    expect(isAppChord('palette.toggle')).toBe(true)
    expect(isAppChord('app.openSettings')).toBe(true)
    expect(isAppChord('find')).toBe(false)
    expect(isAppChord(null)).toBe(false)
  })
})

describe('chordLabel', () => {
  it('labels chords per platform', () => {
    expect(chordLabel('palette.toggle', true)).toBe('⌘K')
    expect(chordLabel('palette.toggle', false)).toBe('Ctrl+Shift+P')
    expect(chordLabel('find', false)).toBe('Ctrl+Shift+F')
  })
})

describe('workspace digits', () => {
  it('maps Ctrl+1..9 (Cmd+1..9 on macOS) to the workspace at that position', () => {
    expect(matchChord(key('1', { ctrlKey: true }), false)).toBe('workspace.goto')
    expect(matchChord(key('9', { metaKey: true }), true)).toBe('workspace.goto')
    expect(isAppChord('workspace.goto')).toBe(true)
    expect(workspaceDigit('1')).toBe(0)
    expect(workspaceDigit('9')).toBe(8)
  })

  it('leaves Ctrl+0, Ctrl+Shift+digit and plain digits to the shell', () => {
    expect(matchChord(key('0', { ctrlKey: true }), false)).toBeNull()
    expect(matchChord(key('1', { ctrlKey: true, shiftKey: true }), false)).toBeNull()
    expect(matchChord(key('1'), false)).toBeNull()
    expect(workspaceDigit('0')).toBeNull()
  })
})

describe('effectiveBindings', () => {
  it('starts from the platform defaults', () => {
    const other = effectiveBindings({}, false)
    const mac = effectiveBindings({}, true)
    expect(other.bySignature.get('Ctrl+Shift+P')).toBe('palette.toggle')
    expect(mac.bySignature.get('Cmd+K')).toBe('palette.toggle')
    expect(other.bySignature.get('Ctrl+1-9')).toBe('workspace.goto')
  })

  it('overrides a default, unbinds with null, and binds commands without a default', () => {
    const table = effectiveBindings(
      {
        'palette.toggle': 'Ctrl+Shift+Y',
        'view.toggleRail': null,
        'pane.splitRight': 'Ctrl+Alt+D',
      },
      false,
    )
    expect(table.bySignature.get('Ctrl+Shift+Y')).toBe('palette.toggle')
    expect(table.bySignature.has('Ctrl+Shift+P')).toBe(false)
    expect(table.byId.has('view.toggleRail')).toBe(false)
    expect(table.bySignature.get('Ctrl+Alt+D')).toBe('pane.splitRight')
  })

  it('ignores an override that would steal a terminal key and keeps the default', () => {
    const table = effectiveBindings({ 'palette.toggle': 'Ctrl+R', find: 'Escape' }, false)
    expect(table.bySignature.get('Ctrl+Shift+P')).toBe('palette.toggle')
    expect(table.bySignature.has('Ctrl+R')).toBe(false)
    expect(table.bySignature.get('Ctrl+Shift+F')).toBe('find')
  })

  it('reads one setting per platform: a Ctrl chord is ignored on macOS, Mod works on both', () => {
    const user = { 'palette.toggle': 'Ctrl+Shift+Y', 'history.search': 'Mod+Shift+J' }
    expect(effectiveBindings(user, true).bySignature.get('Cmd+K')).toBe('palette.toggle')
    expect(effectiveBindings(user, true).bySignature.get('Shift+Cmd+J')).toBe('history.search')
    expect(effectiveBindings(user, false).bySignature.get('Ctrl+Shift+J')).toBe('history.search')
  })

  it('lets a user binding win a chord still held by a default', () => {
    const table = effectiveBindings({ 'pane.splitDown': 'Ctrl+Shift+P' }, false)
    expect(table.bySignature.get('Ctrl+Shift+P')).toBe('pane.splitDown')
  })

  it('keeps 1-9 for workspace.goto only', () => {
    const table = effectiveBindings(
      { 'workspace.goto': 'Ctrl+Shift+K', 'palette.toggle': 'Ctrl+Alt+1-9' },
      false,
    )
    expect(table.bySignature.get('Ctrl+1-9')).toBe('workspace.goto')
    expect(table.bySignature.get('Ctrl+Shift+P')).toBe('palette.toggle')
  })
})

describe('user keybindings', () => {
  it('match live: the new chord fires and the old one stops', () => {
    bind({ 'palette.toggle': 'Ctrl+Shift+Y' })
    const cs = { ctrlKey: true, shiftKey: true }
    expect(matchChord(key('Y', cs), false)).toBe('palette.toggle')
    expect(matchChord(key('P', cs), false)).toBeNull()
    expect(chordLabel('palette.toggle', false)).toBe('Ctrl+Shift+Y')
    bind({})
    expect(matchChord(key('P', cs), false)).toBe('palette.toggle')
  })

  it('treat a bound palette command as an app chord', () => {
    bind({ 'pane.splitRight': 'Ctrl+Alt+D' })
    const chord = matchChord(key('d', { ctrlKey: true, altKey: true }), false)
    expect(chord).toBe('pane.splitRight')
    expect(isAppChord(chord)).toBe(true)
  })

  it('keep a rebound terminal chord out of the window handler', () => {
    bind({ find: 'Ctrl+Alt+F' })
    const chord = matchChord(key('f', { ctrlKey: true, altKey: true }), false)
    expect(chord).toBe('find')
    expect(isAppChord(chord)).toBe(false)
  })

  it('show no label once unbound', () => {
    bind({ 'history.search': null })
    expect(chordLabel('history.search', false)).toBeNull()
    expect(matchChord(key('H', { ctrlKey: true, shiftKey: true }), false)).toBeNull()
  })

  it('move workspace jumps to another modifier and read the digit from the key code', () => {
    bind({ 'workspace.goto': 'Ctrl+Shift+1-9' })
    const e = { ...key('@', { ctrlKey: true, shiftKey: true }), code: 'Digit2' }
    expect(matchChord(e, false)).toBe('workspace.goto')
    expect(workspaceIndex(e)).toBe(1)
    expect(matchChord(key('2', { ctrlKey: true }), false)).toBeNull()
  })
})

describe('conflictsWith', () => {
  it('names the other command bound to the same chord, including a digit in 1-9', () => {
    const spec = (text: string) =>
      parseChord(text, false) as NonNullable<ReturnType<typeof parseChord>>
    expect(conflictsWith('view.toggleRail', spec('Ctrl+Shift+P'), false)).toEqual([
      'palette.toggle',
    ])
    expect(conflictsWith('palette.toggle', spec('Ctrl+Shift+P'), false)).toEqual([])
    expect(conflictsWith('palette.toggle', spec('Ctrl+4'), false)).toEqual(['workspace.goto'])
    expect(conflictsWith('palette.toggle', spec('Ctrl+Shift+Y'), false)).toEqual([])
  })
})

describe('bindableIds', () => {
  it('lists every default chord and each visible palette command', () => {
    commands.register({ id: 'test.visible', title: 'Visible', run: () => {} })
    commands.register({ id: 'test.hidden', title: 'Hidden', hidden: true, run: () => {} })
    try {
      const ids = bindableIds()
      expect(ids).toEqual(
        expect.arrayContaining(['palette.toggle', 'copy', 'workspace.goto', 'test.visible']),
      )
      expect(ids).not.toContain('test.hidden')
    } finally {
      commands.unregister('test.visible')
      commands.unregister('test.hidden')
    }
  })
})

describe('setKeybindingSetting', () => {
  it('sets one command by its dotted id', () => {
    setKeybindingSetting('keybindings.palette.toggle', 'Ctrl+Shift+Y', false)
    expect(useSettingsStore.getState().keybindings['palette.toggle']).toBe('Ctrl+Shift+Y')
    setKeybindingSetting('keybindings.view.toggleRail', null, false)
    expect(useSettingsStore.getState().keybindings['view.toggleRail']).toBeNull()
  })

  it('refuses a chord that steals a terminal key, naming the reason', () => {
    expect(() => setKeybindingSetting('keybindings.palette.toggle', 'Ctrl+R', false)).toThrow(
      /plain Ctrl key the shell uses/,
    )
    expect(() => setKeybindingSetting('keybindings.find', 'Escape', false)).toThrow(/Escape/)
    expect(() => setKeybindingSetting('keybindings.find', 'Alt+F', false)).toThrow(/Ctrl or Cmd/)
    expect(() => setKeybindingSetting('keybindings.find', 42, false)).toThrow(
      /chord string or null/,
    )
    expect(() => setKeybindingSetting('keybindings.find', 'Ctrl+Nope', false)).toThrow(
      /is not a chord/,
    )
    expect(useSettingsStore.getState().keybindings).toEqual({})
  })

  it('replaces the whole map only when every entry passes', () => {
    expect(() =>
      setKeybindingSetting('keybindings', { find: 'Ctrl+Alt+F', 'palette.toggle': 'Tab' }, false),
    ).toThrow(/Tab/)
    expect(useSettingsStore.getState().keybindings).toEqual({})
    setKeybindingSetting('keybindings', { find: 'Ctrl+Alt+F' }, false)
    expect(useSettingsStore.getState().keybindings).toEqual({ find: 'Ctrl+Alt+F' })
    expect(() => setKeybindingSetting('keybindings', ['Ctrl+K'], false)).toThrow(/object/)
  })

  it('refuses prototype keys', () => {
    expect(() => setKeybindingSetting('keybindings.__proto__', 'Ctrl+Shift+Y', false)).toThrow(
      /invalid keybinding id/,
    )
  })
})
