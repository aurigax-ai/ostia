import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ChordSpec,
  bindingProblem,
  chordTexts,
  formatChord,
  parseChord,
  stealsTerminalKey,
  usedByMonaco,
} from '@shared/chordSpec'
import { parseKeymapBindings } from '@shared/keymapFile'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commands } from '../commands/registry'
import { en } from '../i18n/dict'
import { useKeymapStore } from '../stores/keymapStore'
import { useSettingsStore } from '../stores/settingsStore'
import {
  DEFAULT_CHORDS,
  type KeyLike,
  type KeybindingMap,
  TERMINAL_COMMAND_CHORDS,
  baseChord,
  baseChords,
  bindableIds,
  checkBinding,
  chordLabel,
  chordsOf,
  chordsWithout,
  conflictsWith,
  currentBindings,
  defaultChords,
  effectiveBindings,
  findStep,
  isAppChord,
  isBrowserChord,
  isTerminalCommandChord,
  matchChord,
  runAppChord,
  setKeybindingSetting,
  terminalKeyConflicts,
  workspaceDigit,
  workspaceIndex,
} from './chords'

const initialSettings = useSettingsStore.getState()
const initialKeymap = useKeymapStore.getState()

afterEach(() => {
  useSettingsStore.setState(initialSettings, true)
  useKeymapStore.setState(initialKeymap, true)
})

const bind = (keybindings: KeybindingMap): void => useSettingsStore.setState({ keybindings })

const useKeymap = (bindings: KeybindingMap): void =>
  useKeymapStore.setState({
    key: 'keys/test\n1.0.0',
    ref: 'keys/test',
    error: null,
    loaded: { extId: 'keys', id: 'test', label: 'Test', bindings, skipped: [] },
  })

const chord = (text: string, mac: boolean): ChordSpec => {
  const spec = parseChord(text, mac)
  if (!spec) throw new Error(`not a chord: ${text}`)
  return spec
}

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

  it('opens a tab in the pane with Cmd+T and Ctrl+Shift+T, and a workspace with Cmd+N and Ctrl+Shift+N', () => {
    const cs = { ctrlKey: true, shiftKey: true }
    const cmd = { metaKey: true }
    expect(matchChord(key('T', cs), false)).toBe('tab.new')
    expect(matchChord(key('t', cmd), true)).toBe('tab.new')
    expect(matchChord(key('N', cs), false)).toBe('workspace.new')
    expect(matchChord(key('n', cmd), true)).toBe('workspace.new')
    expect(isAppChord('tab.new')).toBe(true)
    expect(isAppChord('workspace.new')).toBe(true)
    expect(matchChord(key('t', { ctrlKey: true }), false)).toBeNull()
    expect(matchChord(key('n', { ctrlKey: true }), false)).toBeNull()
    expect(chordLabel('tab.new', false)).toBe('Ctrl+Shift+T')
    expect(chordLabel('tab.new', true)).toBe('⌘T')
    expect(chordLabel('workspace.new', false)).toBe('Ctrl+Shift+N')
    expect(chordLabel('workspace.new', true)).toBe('⌘N')
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

  it('maps the dashboard to Ctrl+Shift+D and Cmd+Shift+D, leaving Ctrl+D to the shell', () => {
    const ctrlShiftD = matchChord(key('D', { ctrlKey: true, shiftKey: true }), false)
    const cmdShiftD = matchChord(key('d', { metaKey: true, shiftKey: true }), true)
    expect(ctrlShiftD).toBe('dashboard.toggle')
    expect(cmdShiftD).toBe('dashboard.toggle')
    expect(isAppChord(ctrlShiftD)).toBe(true)
    expect(matchChord(key('d', { ctrlKey: true }), false)).toBeNull()
    expect(chordLabel('dashboard.toggle', false)).toBe('Ctrl+Shift+D')
    expect(chordLabel('dashboard.toggle', true)).toBe('⌘⇧D')
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

  it('opens workflow search with Ctrl+Shift+S or Cmd+Shift+S, a chord free in the shell and Monaco', () => {
    expect(matchChord(key('S', { ctrlKey: true, shiftKey: true }), false)).toBe('workflows.search')
    expect(matchChord(key('s', { metaKey: true, shiftKey: true }), true)).toBe('workflows.search')
    expect(isAppChord('workflows.search')).toBe(true)
    for (const mac of [false, true]) {
      const [spec] = effectiveBindings({}, mac).byId.get('workflows.search') ?? []
      if (!spec) throw new Error('unbound')
      expect(stealsTerminalKey(spec, mac)).toBeNull()
      expect(usedByMonaco(spec, mac)).toBe(false)
      expect(conflictsWith('workflows.search', spec, mac)).toEqual([])
    }
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

  it('keeps Ctrl+0 for zoom reset and leaves Ctrl+Shift+digit and plain digits to the shell', () => {
    expect(matchChord(key('0', { ctrlKey: true }), false)).toBe('view.zoomReset')
    expect(matchChord(key('1', { ctrlKey: true, shiftKey: true }), false)).toBeNull()
    expect(matchChord(key('1'), false)).toBeNull()
    expect(workspaceDigit('0')).toBeNull()
  })
})

describe('zoom chords', () => {
  it('zooms with Ctrl+= and Ctrl+Shift+- and leaves Ctrl+- (readline undo) to the shell', () => {
    expect(matchChord(key('=', { ctrlKey: true, code: 'Equal' }), false)).toBe('view.zoomIn')
    expect(matchChord(key('_', { ctrlKey: true, shiftKey: true, code: 'Minus' }), false)).toBe(
      'view.zoomOut',
    )
    expect(matchChord(key('-', { ctrlKey: true, code: 'Minus' }), false)).toBeNull()
    expect(isAppChord('view.zoomIn')).toBe(true)
  })

  it('uses Cmd on macOS', () => {
    expect(matchChord(key('=', { metaKey: true, code: 'Equal' }), true)).toBe('view.zoomIn')
    expect(matchChord(key('-', { metaKey: true, code: 'Minus' }), true)).toBe('view.zoomOut')
    expect(matchChord(key('0', { metaKey: true, code: 'Digit0' }), true)).toBe('view.zoomReset')
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

describe('a keymap between the defaults and the user', () => {
  it('replaces defaults, unbinds with null, and leaves the rest of the defaults alone', () => {
    const table = effectiveBindings({}, false, {
      'palette.toggle': 'Ctrl+Alt+P',
      'view.toggleRail': null,
      'agent.resume': 'Ctrl+Alt+R',
    })
    expect(table.bySignature.get('Ctrl+Alt+P')).toBe('palette.toggle')
    expect(table.bySignature.has('Ctrl+Shift+P')).toBe(false)
    expect(table.byId.has('view.toggleRail')).toBe(false)
    expect(table.bySignature.get('Ctrl+Alt+R')).toBe('agent.resume')
    expect(table.bySignature.get('Ctrl+Shift+F')).toBe('find')
  })

  it('lets the user override a keymap chord and bring back what the keymap unbinds', () => {
    const keymap = { 'palette.toggle': 'Ctrl+Alt+P', 'view.toggleRail': null }
    const table = effectiveBindings(
      { 'palette.toggle': 'Ctrl+Shift+Y', 'view.toggleRail': 'Ctrl+Alt+B' },
      false,
      keymap,
    )
    expect(table.bySignature.get('Ctrl+Shift+Y')).toBe('palette.toggle')
    expect(table.bySignature.has('Ctrl+Alt+P')).toBe(false)
    expect(table.bySignature.get('Ctrl+Alt+B')).toBe('view.toggleRail')
    expect(
      effectiveBindings({ 'palette.toggle': null }, false, keymap).byId.has('palette.toggle'),
    ).toBe(false)
  })

  it('keeps the default where a keymap entry is unusable on this platform', () => {
    const table = effectiveBindings({}, false, {
      'palette.toggle': 'Ctrl+R',
      find: 'Escape',
      'view.zoomIn': 'Ctrl+Alt+1-9',
    })
    expect(table.bySignature.get('Ctrl+Shift+P')).toBe('palette.toggle')
    expect(table.bySignature.get('Ctrl+Shift+F')).toBe('find')
    expect(table.bySignature.get('Ctrl+=')).toBe('view.zoomIn')
  })

  it('gives a contested chord to the user over the keymap, and to the keymap over a default', () => {
    const keymap = { 'pane.splitDown': 'Ctrl+Shift+P', 'pane.splitRight': 'Ctrl+Shift+F' }
    const table = effectiveBindings({ 'pane.zoom': 'Ctrl+Shift+F' }, false, keymap)
    expect(table.bySignature.get('Ctrl+Shift+P')).toBe('pane.splitDown')
    expect(table.bySignature.get('Ctrl+Shift+F')).toBe('pane.zoom')
  })

  it('is what matching, labels, conflicts and the reset target see once loaded', () => {
    useKeymap({ 'pane.splitRight': 'Ctrl+Alt+D' })
    const ca = { ctrlKey: true, altKey: true }
    expect(matchChord(key('d', ca), false)).toBe('pane.splitRight')
    expect(matchChord(key('\\', ca), false)).toBeNull()
    expect(chordLabel('pane.splitRight', false)).toBe('Ctrl+Alt+D')
    expect(conflictsWith('palette.toggle', chord('Ctrl+Alt+D', false), false)).toEqual([
      'pane.splitRight',
    ])
    expect(baseChord('pane.splitRight', false)).toEqual(chord('Ctrl+Alt+D', false))
    expect(baseChord('palette.toggle', false)).toEqual(chord('Ctrl+Shift+P', false))
  })

  it('falls back to the keymap chord when the user’s override is reset, and to the default without it', () => {
    useKeymap({ 'pane.splitRight': 'Ctrl+Alt+D' })
    bind({ 'pane.splitRight': 'Ctrl+Alt+R' })
    expect(chordLabel('pane.splitRight', false)).toBe('Ctrl+Alt+R')
    useSettingsStore.getState().resetKeybinding('pane.splitRight')
    expect(chordLabel('pane.splitRight', false)).toBe('Ctrl+Alt+D')
    useKeymapStore.setState({ key: null, ref: null, loaded: null })
    expect(chordLabel('pane.splitRight', false)).toBe('Ctrl+Alt+\\')
  })
})

describe('the macOS keymap that follows cmux', () => {
  const dir = join(__dirname, '../../extensions/keymap-macos')
  const manifest = JSON.parse(readFileSync(join(dir, 'ostia.json'), 'utf8'))
  const raw = JSON.parse(readFileSync(join(dir, manifest.contributes.keymaps[0].path), 'utf8'))
  const parsed = parseKeymapBindings(raw, true)
  const bindings = parsed.ok ? parsed.bindings : {}

  it('names only app commands Ostia ships, each with a chord that loads on macOS', () => {
    expect(parsed.ok && parsed.skipped).toEqual([])
    const shipped = [...Object.keys(DEFAULT_CHORDS), ...Object.keys(en.commands.titles)]
    for (const [id, text] of Object.entries(raw.bindings as Record<string, string>)) {
      expect(shipped, id).toContain(id)
      expect(isAppChord(id), id).toBe(true)
      expect(checkBinding(id, text, true), id).toBeNull()
    }
  })

  it('leaves no two commands on one chord on macOS', () => {
    useKeymap(bindings)
    const { byId, bySignature } = currentBindings(true)
    for (const [id, text] of Object.entries(bindings)) {
      const expected = text === null ? undefined : chordTexts(text).map((t) => chord(t, true))
      expect(byId.get(id), id).toEqual(expected)
    }
    for (const [id, specs] of byId) {
      for (const spec of specs) expect(conflictsWith(id, spec, true), id).toEqual([])
    }
    expect(bySignature.size).toBe([...byId.values()].flat().length)
  })

  it('binds cmux’s shortcuts and moves the dashboard off ⇧⌘D', () => {
    useKeymap(bindings)
    const cmd = { metaKey: true }
    const cmdShift = { metaKey: true, shiftKey: true }
    const cmdAlt = { metaKey: true, altKey: true }
    expect(matchChord(key('P', cmdShift), true)).toBe('palette.toggle')
    expect(matchChord(key('b', cmd), true)).toBe('view.toggleRail')
    expect(matchChord(key('n', cmd), true)).toBe('workspace.new')
    expect(matchChord(key('d', cmd), true)).toBe('pane.splitRight')
    expect(matchChord(key('D', cmdShift), true)).toBe('pane.splitDown')
    expect(matchChord(key('ArrowLeft', cmdAlt), true)).toBe('pane.focusLeft')
    expect(matchChord(key('ArrowRight', cmdAlt), true)).toBe('pane.focusRight')
    expect(matchChord(key('ArrowUp', cmdAlt), true)).toBe('pane.focusUp')
    expect(matchChord(key('ArrowDown', cmdAlt), true)).toBe('pane.focusDown')
    expect(matchChord({ ...key('Enter', cmdShift), code: 'Enter' }, true)).toBe('pane.zoom')
    expect(matchChord({ ...key('∂', cmdAlt), code: 'KeyD' }, true)).toBe('dashboard.toggle')
    expect(matchChord(key('k', cmd), true)).toBeNull()
    expect(matchChord(key('t', cmd), true)).toBe('tab.new')
  })

  it('changes nothing until it is the chosen keymap', () => {
    expect(chordLabel('pane.splitRight', true)).toBe('⌥⌘\\')
    expect(matchChord(key('d', { metaKey: true }), true)).toBeNull()
  })
})

describe('the macOS keymap that follows iTerm2', () => {
  const dir = join(__dirname, '../../extensions/keymap-macos')
  const manifest = JSON.parse(readFileSync(join(dir, 'ostia.json'), 'utf8'))
  const entry = manifest.contributes.keymaps.find((k: { id: string }) => k.id === 'iterm2')
  const raw = JSON.parse(readFileSync(join(dir, entry.path), 'utf8'))
  const parsed = parseKeymapBindings(raw, true)
  const bindings = parsed.ok ? parsed.bindings : {}

  it('is offered on macOS only and names only commands Ostia ships', () => {
    expect(entry).toMatchObject({ label: 'macOS (iTerm2)', platform: 'darwin' })
    expect(parsed.ok && parsed.skipped).toEqual([])
    const shipped = [...Object.keys(DEFAULT_CHORDS), ...Object.keys(en.commands.titles)]
    for (const [id, text] of Object.entries(raw.bindings as Record<string, string>)) {
      expect(shipped, id).toContain(id)
      expect(checkBinding(id, text, true), id).toBeNull()
    }
  })

  it('leaves no two commands on one chord on macOS', () => {
    useKeymap(bindings)
    const { byId, bySignature } = currentBindings(true)
    for (const [id, specs] of byId) {
      for (const spec of specs) expect(conflictsWith(id, spec, true), id).toEqual([])
    }
    expect(bySignature.size).toBe([...byId.values()].flat().length)
  })

  it('scrolls a line with ⌘↑ ⌘↓, keeps blocks on ⇧⌘↑ ⇧⌘↓ and leaves ⌘← ⌘→ to the line ends', () => {
    useKeymap(bindings)
    const cmd = { metaKey: true }
    const cmdShift = { metaKey: true, shiftKey: true }
    expect(matchChord(key('ArrowUp', cmd), true)).toBe('terminal.scrollLineUp')
    expect(matchChord(key('ArrowDown', cmd), true)).toBe('terminal.scrollLineDown')
    expect(matchChord(key('ArrowUp', cmdShift), true)).toBe('block.selectPrev')
    expect(matchChord(key('ArrowDown', cmdShift), true)).toBe('block.selectNext')
    expect(matchChord(key('n', cmd), true)).toBe('workspace.new')
    expect(matchChord(key('t', cmd), true)).toBe('tab.new')
    expect(matchChord(key('Tab', { ctrlKey: true }), true)).toBe('tab.next')
    expect(matchChord(key('ArrowLeft', cmdShift), true)).toBe('tab.moveLeft')
    expect(matchChord(key('Home', cmd), true)).toBe('terminal.scrollToTop')
    expect(matchChord(key('ArrowLeft', cmd), true)).toBeNull()
    expect(matchChord(key('ArrowRight', cmd), true)).toBeNull()
  })
})

describe('commands with several chords', () => {
  const cs = { ctrlKey: true, shiftKey: true }

  it('run from any of their chords, and show the first one', () => {
    bind({ 'palette.toggle': ['Ctrl+Shift+Y', 'Ctrl+Alt+P'] })
    expect(matchChord(key('Y', cs), false)).toBe('palette.toggle')
    expect(matchChord(key('p', { ctrlKey: true, altKey: true }), false)).toBe('palette.toggle')
    expect(matchChord(key('P', cs), false)).toBeNull()
    expect(chordLabel('palette.toggle', false)).toBe('Ctrl+Shift+Y')
    expect(chordsOf('palette.toggle', false).map((c) => formatChord(c, false))).toEqual([
      'Ctrl+Shift+Y',
      'Ctrl+Alt+P',
    ])
  })

  it('keep the chords that work here when some in the list do not, and the default when none do', () => {
    bind({ 'palette.toggle': ['Ctrl+R', 'Ctrl+Shift+Y'], 'view.toggleRail': ['Ctrl+R'] })
    expect(chordsOf('palette.toggle', false).map((c) => formatChord(c, false))).toEqual([
      'Ctrl+Shift+Y',
    ])
    expect(chordLabel('view.toggleRail', false)).toBe('Ctrl+Shift+B')
  })

  it('come from a keymap list too, and a user string replaces the whole list', () => {
    useKeymap({ 'tab.next': ['Ctrl+Tab', 'Cmd+Shift+]'] })
    expect(matchChord(key('Tab', { ctrlKey: true }), true)).toBe('tab.next')
    expect(matchChord(key(']', { metaKey: true, shiftKey: true }), true)).toBe('tab.next')
    expect(baseChords('tab.next', true)).toHaveLength(2)
    bind({ 'tab.next': 'Cmd+Alt+]' })
    expect(matchChord(key(']', { metaKey: true, shiftKey: true }), true)).toBeNull()
    expect(matchChord(key('Tab', { ctrlKey: true }), true)).toBeNull()
    expect(chordLabel('tab.next', true)).toBe('⌥⌘]')
  })

  it('conflict on any of their chords, and lose only that one when it is taken', () => {
    bind({ 'palette.toggle': ['Ctrl+Shift+Y', 'Ctrl+Alt+P'] })
    const taken = chord('Ctrl+Alt+P', false)
    expect(conflictsWith('view.toggleRail', taken, false)).toEqual(['palette.toggle'])
    expect(chordsWithout('palette.toggle', taken, false)).toEqual(['Ctrl+Shift+Y'])
    expect(chordsWithout('palette.toggle', chord('Ctrl+Shift+Y', false), false)).toEqual([
      'Ctrl+Alt+P',
    ])
  })

  it('leave the defaults as single chords', () => {
    for (const mac of [true, false]) {
      for (const id of Object.keys(DEFAULT_CHORDS)) {
        expect(defaultChords(id, mac).length, `${id} ${mac}`).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('setKeybindingSetting with lists', () => {
  it('takes a list of chords from an agent and refuses one bad chord in it', () => {
    setKeybindingSetting('keybindings.palette.toggle', ['Ctrl+Shift+Y', 'Ctrl+Alt+P'], false)
    expect(useSettingsStore.getState().keybindings['palette.toggle']).toEqual([
      'Ctrl+Shift+Y',
      'Ctrl+Alt+P',
    ])
    expect(() => setKeybindingSetting('keybindings.find', ['Ctrl+Alt+F', 'Ctrl+R'], false)).toThrow(
      /keybindings.find: "Ctrl\+R" is a plain Ctrl key/,
    )
    expect(() => setKeybindingSetting('keybindings.find', [], false)).toThrow(/1 to 8 chords/)
    expect(() => setKeybindingSetting('keybindings.find', [7], false)).toThrow(/chord string/)
    expect(useSettingsStore.getState().keybindings.find).toBeUndefined()
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

describe('terminalKeyConflicts', () => {
  const spec = (text: string) =>
    parseChord(text, false) as NonNullable<ReturnType<typeof parseChord>>

  it('ignores browser chords, which never take a key from a terminal', () => {
    expect(conflictsWith('', spec('Alt+Left'), false)).toEqual(['browser.back'])
    expect(terminalKeyConflicts(spec('Alt+Left'), false)).toEqual([])
    expect(terminalKeyConflicts(spec('Alt+Right'), false)).toEqual([])
  })

  it('names app and terminal chords that take the same key', () => {
    expect(terminalKeyConflicts(spec('Ctrl+Shift+P'), false)).toEqual(['palette.toggle'])
    expect(terminalKeyConflicts(spec('Ctrl+Shift+C'), false)).toEqual(['copy'])
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
      /chord string, a list of them or null/,
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

describe('DEFAULT_CHORDS', () => {
  const PANE_WORK = [
    'pane.splitRight',
    'pane.splitDown',
    'pane.focusLeft',
    'pane.focusRight',
    'pane.focusUp',
    'pane.focusDown',
    'pane.zoom',
    'pane.close',
    'workspace.next',
    'workspace.previous',
  ]

  it('never steal a shell key or share a chord, and pane work leaves Monaco alone', () => {
    for (const mac of [false, true]) {
      const { byId } = effectiveBindings({}, mac)
      const seen = new Map<string, string>()
      for (const id of Object.keys(DEFAULT_CHORDS)) {
        const specs = byId.get(id) ?? []
        const text = DEFAULT_CHORDS[id as keyof typeof DEFAULT_CHORDS][mac ? 0 : 1]
        if (specs.length === 0 && text === '') continue
        if (specs.length === 0) {
          throw new Error(`${id} has no default on ${mac ? 'macOS' : 'Linux'}`)
        }
        for (const spec of specs) {
          expect(bindingProblem(id, spec, mac), id).toBeNull()
          if (PANE_WORK.includes(id)) expect(usedByMonaco(spec, mac), id).toBe(false)
          const signature = formatChord(spec, mac)
          expect(seen.get(signature), `${id} vs ${seen.get(signature)}`).toBeUndefined()
          seen.set(signature, id)
        }
      }
    }
  })

  it('binds pane splits, directional focus, zoom, close and workspace stepping on Linux', () => {
    const csa = { ctrlKey: true, shiftKey: true, altKey: true }
    expect(matchChord(key('\\', { ctrlKey: true, altKey: true }), false)).toBe('pane.splitRight')
    expect(matchChord({ ...key('_', { ctrlKey: true, altKey: true }), code: 'Minus' }, false)).toBe(
      'pane.splitDown',
    )
    expect(matchChord(key('H', csa), false)).toBe('pane.focusLeft')
    expect(matchChord(key('J', csa), false)).toBe('pane.focusDown')
    expect(matchChord(key('K', csa), false)).toBe('pane.focusUp')
    expect(matchChord(key('L', csa), false)).toBe('pane.focusRight')
    expect(matchChord(key('X', { ctrlKey: true, shiftKey: true }), false)).toBe('pane.zoom')
    expect(matchChord(key('W', { ctrlKey: true, shiftKey: true }), false)).toBe('pane.close')
    expect(matchChord(key('PageDown', { ctrlKey: true, shiftKey: true }), false)).toBe(
      'workspace.next',
    )
    expect(matchChord(key('PageUp', { ctrlKey: true, shiftKey: true }), false)).toBe(
      'workspace.previous',
    )
    expect(matchChord(key('PageDown', { ctrlKey: true }), false)).toBeNull()
  })
})

describe('scroll and tab move chords', () => {
  it('scroll the terminal and move tabs with iTerm2’s keys on macOS, from the terminal only', () => {
    const cmd = { metaKey: true }
    const cmdShift = { metaKey: true, shiftKey: true }
    expect(matchChord(key('Home', cmd), true)).toBe('terminal.scrollToTop')
    expect(matchChord(key('End', cmd), true)).toBe('terminal.scrollToBottom')
    expect(matchChord(key('PageUp', cmd), true)).toBe('terminal.scrollPageUp')
    expect(matchChord(key('PageDown', cmd), true)).toBe('terminal.scrollPageDown')
    expect(matchChord(key('ArrowLeft', cmdShift), true)).toBe('tab.moveLeft')
    expect(matchChord(key('ArrowRight', cmdShift), true)).toBe('tab.moveRight')
    expect(matchChord(key('ArrowUp', cmd), true)).toBe('block.selectPrev')
    expect(matchChord(key('ArrowLeft', cmd), true)).toBeNull()
    expect(matchChord(key('PageUp', { shiftKey: true }), true)).toBeNull()
    for (const id of TERMINAL_COMMAND_CHORDS) {
      expect(isTerminalCommandChord(id), id).toBe(true)
      expect(isAppChord(id), id).toBe(false)
    }
    expect(chordLabel('terminal.scrollLineUp', true)).toBeNull()
  })

  it('have no default on Linux yet, so no Linux key changes', () => {
    for (const id of TERMINAL_COMMAND_CHORDS) expect(chordLabel(id, false), id).toBeNull()
    for (const event of [
      key('Home', { ctrlKey: true }),
      key('End', { ctrlKey: true }),
      key('PageUp', { ctrlKey: true }),
      key('ArrowLeft', { ctrlKey: true, shiftKey: true }),
    ]) {
      expect(matchChord(event, false), JSON.stringify(event)).toBeNull()
    }
  })
})

describe('runAppChord', () => {
  afterEach(() => {
    commands.unregister('palette.toggle')
  })

  it('runs the command an app chord names and stops the key, so an editor never sees it', () => {
    const ran: string[] = []
    commands.register({ id: 'palette.toggle', title: 'Palette', run: () => void ran.push('run') })
    const preventDefault = vi.fn()
    expect(runAppChord({ ...key('k', { metaKey: true }), preventDefault }, true)).toBe(true)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(ran).toEqual(['run'])
  })

  it('leaves a key that is no app chord alone', () => {
    const preventDefault = vi.fn()
    expect(runAppChord({ ...key('k', { ctrlKey: true }), preventDefault }, false)).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
  })
})

describe('browser chords', () => {
  it('are neither app nor terminal chords, so only a browser pane acts on them', () => {
    for (const id of [
      'browser.focusAddress',
      'browser.reload',
      'browser.back',
      'browser.forward',
    ]) {
      expect(isBrowserChord(id), id).toBe(true)
      expect(isAppChord(id), id).toBe(false)
    }
    expect(isBrowserChord('palette.toggle')).toBe(false)
    expect(isBrowserChord(null)).toBe(false)
  })

  it('have default chords that load on both platforms', () => {
    for (const mac of [true, false]) {
      for (const id of [
        'browser.focusAddress',
        'browser.reload',
        'browser.back',
        'browser.forward',
      ]) {
        const [macText, otherText] = DEFAULT_CHORDS[id as keyof typeof DEFAULT_CHORDS]
        for (const text of chordTexts(mac ? macText : otherText)) {
          expect(checkBinding(id, text, mac), `${id} ${mac}`).toBeNull()
        }
      }
    }
    expect(DEFAULT_CHORDS['browser.reload']).toEqual(['Cmd+R', 'Ctrl+F5'])
  })

  it('go back and forward with Alt+Left and Alt+Right on Linux, like Chrome and Firefox', () => {
    const alt = { altKey: true }
    expect(matchChord(key('ArrowLeft', alt), false)).toBe('browser.back')
    expect(matchChord(key('ArrowRight', alt), false)).toBe('browser.forward')
    expect(matchChord(key('ArrowLeft', { ctrlKey: true, altKey: true }), false)).toBeNull()
    expect(matchChord(key('[', { metaKey: true }), true)).toBe('browser.back')
    expect(checkBinding('browser.back', 'Alt+Left', false)).toBeNull()
    expect(checkBinding('browser.back', 'Alt+Tab', false)).toBe('tab')
    expect(checkBinding('palette.toggle', 'Alt+Left', false)).toBe('needs-modifier')
  })

  it('does not run anything for a browser chord pressed outside a browser pane', () => {
    const exec = vi.spyOn(commands, 'exec')
    const e = {
      key: 'r',
      code: 'KeyR',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: true,
      preventDefault: vi.fn(),
    }
    expect(matchChord(e, true)).toBe('browser.reload')
    expect(runAppChord(e, true)).toBe(false)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('find next and previous', () => {
  const cmd = { metaKey: true }
  const cmdShift = { metaKey: true, shiftKey: true }

  it('step with ⌘G and ⇧⌘G on macOS, in the surface that has the focus', () => {
    expect(matchChord(key('g', cmd), true)).toBe('find.next')
    expect(matchChord(key('G', cmdShift), true)).toBe('find.previous')
    expect(findStep('find.next')).toBe(1)
    expect(findStep('find.previous')).toBe(-1)
    expect(findStep('find')).toBeNull()
    expect(findStep(null)).toBeNull()
    expect(isAppChord('find.next')).toBe(false)
    expect(isAppChord('find.previous')).toBe(false)
    expect(chordLabel('find.next', true)).toBe('⌘G')
    expect(chordLabel('find.previous', true)).toBe('⌘⇧G')
  })

  it('have no chord on Linux, where Ctrl+G belongs to the shell', () => {
    expect(chordLabel('find.next', false)).toBeNull()
    expect(chordLabel('find.previous', false)).toBeNull()
    expect(matchChord(key('g', { ctrlKey: true }), false)).toBeNull()
    expect(matchChord(key('G', { ctrlKey: true, shiftKey: true }), false)).toBeNull()
  })

  it('take a chord a Linux user binds', () => {
    bind({ 'find.next': 'Ctrl+Shift+G' })
    expect(matchChord(key('G', { ctrlKey: true, shiftKey: true }), false)).toBe('find.next')
  })
})

describe('search files', () => {
  it('opens the Files search with ⇧⌘F on macOS and has no default on Linux, where Ctrl+Shift+F is find', () => {
    const chord = matchChord(key('F', { metaKey: true, shiftKey: true }), true)
    expect(chord).toBe('view.searchFiles')
    expect(isAppChord(chord)).toBe(true)
    expect(chordLabel('view.searchFiles', true)).toBe('⌘⇧F')
    expect(chordLabel('view.searchFiles', false)).toBeNull()
    expect(matchChord(key('F', { ctrlKey: true, shiftKey: true }), false)).toBe('find')
  })
})
