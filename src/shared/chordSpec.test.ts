import { describe, expect, it } from 'vitest'
import {
  CHORDS_PER_COMMAND_MAX,
  type ChordSpec,
  DOUBLE_SHIFT,
  type TapKey,
  bindingProblem,
  checkBinding,
  chordText,
  doubleShiftDetector,
  formatChord,
  formatScopedChord,
  overlaps,
  parseChord,
  parseKeybindings,
  parseScopedChord,
  sameScope,
  specFromEvent,
  stealsTerminalKey,
  usedByMonaco,
} from './chordSpec'

const chord = (text: string, mac = false): ChordSpec => {
  const spec = parseChord(text, mac)
  if (!spec) throw new Error(`unparseable: ${text}`)
  return spec
}

const event = (key: string, mods: Record<string, boolean> = {}, code?: string) => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('parseChord', () => {
  it('normalizes case, spacing, modifier order and aliases to one canonical string', () => {
    expect(formatChord(chord(' shift + ctrl + k '), false)).toBe('Ctrl+Shift+K')
    expect(formatChord(chord('Control+Option+p'), false)).toBe('Ctrl+Alt+P')
    expect(formatChord(chord('cmd+alt+p', true), true)).toBe('Alt+Cmd+P')
    expect(formatChord(chord('Ctrl+Shift+ArrowUp'), false)).toBe('Ctrl+Shift+Up')
    expect(formatChord(chord('ctrl+shift+↓'), false)).toBe('Ctrl+Shift+Down')
    expect(formatChord(chord('Ctrl+f5'), false)).toBe('Ctrl+F5')
    expect(formatChord(chord('Ctrl+Esc'), false)).toBe('Ctrl+Escape')
  })

  it('reads Mod as Cmd on macOS and Ctrl elsewhere', () => {
    expect(chord('Mod+Shift+K', true)).toMatchObject({ meta: true, ctrl: false, key: 'k' })
    expect(chord('Mod+Shift+K', false)).toMatchObject({ meta: false, ctrl: true, key: 'k' })
  })

  it('writes the meta key as Cmd on macOS and Super elsewhere, and reads both', () => {
    expect(formatChord(chord('Super+K'), false)).toBe('Super+K')
    expect(formatChord(chord('Super+K', true), true)).toBe('Cmd+K')
    expect(chord('Meta+K')).toEqual(chord('Cmd+K'))
  })

  it('rejects unknown modifiers, unknown keys, repeats and empty parts', () => {
    for (const bad of [
      '',
      'Ctrl+',
      '+K',
      'Hyper+K',
      'Ctrl+Ctrl+K',
      'Ctrl+Shift',
      'Ctrl+Foo',
      'Ctrl++',
    ]) {
      expect(parseChord(bad, false)).toBeNull()
    }
  })

  it('accepts the digit range only as a key of its own', () => {
    expect(chord('Ctrl+1-9').key).toBe('1-9')
    expect(parseChord('Ctrl+1-8', false)).toBeNull()
  })
})

describe('chordText', () => {
  it('shows arrows as glyphs and uses the platform style', () => {
    expect(chordText(chord('Ctrl+Shift+Up'), false)).toBe('Ctrl+Shift+↑')
    expect(chordText(chord('Cmd+Shift+U', true), true)).toBe('⌘⇧U')
    expect(chordText(chord('Ctrl+Alt+Cmd+K', true), true)).toBe('⌃⌥⌘K')
    expect(chordText(chord('Super+K'), false)).toBe('Super+K')
  })
})

describe('specFromEvent', () => {
  it('ignores a modifier pressed alone', () => {
    expect(specFromEvent(event('Control', { ctrlKey: true }))).toBeNull()
    expect(specFromEvent(event('Shift', { shiftKey: true }))).toBeNull()
  })

  it('reads shifted digits and punctuation from the physical key', () => {
    expect(specFromEvent(event('!', { ctrlKey: true, shiftKey: true }, 'Digit1'))?.key).toBe('1')
    expect(specFromEvent(event('<', { ctrlKey: true, shiftKey: true }, 'Comma'))?.key).toBe(',')
  })

  it('keeps the layout letter when the key is a letter', () => {
    expect(specFromEvent(event('Z', { ctrlKey: true, shiftKey: true }, 'KeyY'))?.key).toBe('z')
  })

  it('falls back to the key name without a code', () => {
    expect(specFromEvent(event('ArrowUp', { metaKey: true }))).toEqual(chord('Cmd+Up'))
  })
})

describe('stealsTerminalKey', () => {
  it('refuses plain Ctrl+letter, including Ctrl+R, on Linux', () => {
    expect(stealsTerminalKey(chord('Ctrl+R'), false)).toBe('ctrl-key')
    expect(stealsTerminalKey(chord('Ctrl+K'), false)).toBe('ctrl-key')
  })

  it('refuses plain Ctrl keys that send control characters', () => {
    for (const key of ['[', ']', '\\', '/', 'Space', 'Backspace', 'Enter']) {
      expect(stealsTerminalKey(chord(`Ctrl+${key}`), false)).toBe('ctrl-key')
    }
  })

  it('refuses plain and Ctrl arrows but allows Ctrl+Shift arrows', () => {
    expect(stealsTerminalKey(chord('Up'), false)).toBe('bare')
    expect(stealsTerminalKey(chord('Ctrl+Left'), false)).toBe('arrow')
    expect(stealsTerminalKey(chord('Ctrl+Shift+Up'), false)).toBeNull()
  })

  it('refuses Escape with any modifier', () => {
    expect(stealsTerminalKey(chord('Ctrl+Shift+Escape'), false)).toBe('escape')
    expect(stealsTerminalKey(chord('Cmd+Escape', true), true)).toBe('escape')
  })

  it('allows Ctrl+Tab and Ctrl+Shift+Tab on every platform', () => {
    for (const mac of [true, false]) {
      expect(stealsTerminalKey(chord('Ctrl+Tab', mac), mac)).toBeNull()
      expect(stealsTerminalKey(chord('Ctrl+Shift+Tab', mac), mac)).toBeNull()
    }
  })

  it('refuses Tab without Ctrl or with Alt or Cmd', () => {
    expect(stealsTerminalKey(chord('Tab'), false)).toBe('tab')
    expect(stealsTerminalKey(chord('Shift+Tab'), false)).toBe('tab')
    expect(stealsTerminalKey(chord('Alt+Tab'), false)).toBe('tab')
    expect(stealsTerminalKey(chord('Ctrl+Alt+Tab'), false)).toBe('tab')
    expect(stealsTerminalKey(chord('Cmd+Tab', true), true)).toBe('tab')
    expect(stealsTerminalKey(chord('Ctrl+Cmd+Tab', true), true)).toBe('tab')
  })

  it('refuses keys without Ctrl or Super on Linux', () => {
    expect(stealsTerminalKey(chord('K'), false)).toBe('bare')
    expect(stealsTerminalKey(chord('F5'), false)).toBe('bare')
    expect(stealsTerminalKey(chord('Alt+K'), false)).toBe('needs-modifier')
    expect(stealsTerminalKey(chord('Shift+Alt+K'), false)).toBe('needs-modifier')
  })

  it('allows the default chord shapes on Linux', () => {
    for (const ok of [
      'Ctrl+Shift+P',
      'Ctrl+,',
      'Ctrl+1',
      'Ctrl+1-9',
      'Ctrl+Alt+K',
      'Ctrl+F5',
      'Super+K',
    ]) {
      expect(stealsTerminalKey(chord(ok), false)).toBeNull()
    }
  })

  it('allows Ctrl+PageUp and Ctrl+PageDown on Linux, which no shell or Monaco needs', () => {
    expect(stealsTerminalKey(chord('Ctrl+PageUp'), false)).toBeNull()
    expect(stealsTerminalKey(chord('Ctrl+PageDown'), false)).toBeNull()
    expect(stealsTerminalKey(chord('Ctrl+Home'), false)).toBe('ctrl-key')
    expect(stealsTerminalKey(chord('PageUp'), false)).toBe('bare')
    expect(stealsTerminalKey(chord('Alt+PageUp'), false)).toBe('needs-modifier')
    expect(stealsTerminalKey(chord('Ctrl+PageUp', true), true)).toBe('needs-modifier')
  })

  it('needs Cmd on macOS, where Ctrl and Option chords belong to the shell', () => {
    expect(stealsTerminalKey(chord('Cmd+K', true), true)).toBeNull()
    expect(stealsTerminalKey(chord('Cmd+Up', true), true)).toBeNull()
    expect(stealsTerminalKey(chord('Ctrl+Shift+P', true), true)).toBe('needs-modifier')
    expect(stealsTerminalKey(chord('Alt+K', true), true)).toBe('needs-modifier')
  })
})

describe('bindingProblem for browser commands', () => {
  it('lets a browser command take a plain Ctrl key, because a terminal passes it on to the shell', () => {
    for (const id of [
      'browser.focusAddress',
      'browser.reload',
      'browser.back',
      'browser.forward',
    ]) {
      expect(bindingProblem(id, chord('Ctrl+L'), false), id).toBeNull()
      expect(bindingProblem(id, chord('Ctrl+R'), false), id).toBeNull()
      expect(bindingProblem(id, chord('Ctrl+Left'), false), id).toBeNull()
    }
  })

  it('still refuses what no browser command may take', () => {
    expect(bindingProblem('browser.reload', chord('Ctrl+Alt+Tab'), false)).toBe('tab')
    expect(bindingProblem('browser.reload', chord('Ctrl+Escape'), false)).toBe('escape')
    expect(bindingProblem('browser.reload', chord('F5'), false)).toBe('bare')
    expect(bindingProblem('browser.reload', chord('Alt+Tab'), false)).toBe('tab')
  })

  it('keeps plain Ctrl keys closed to every other command', () => {
    expect(bindingProblem('palette.toggle', chord('Ctrl+L'), false)).toBe('ctrl-key')
    expect(bindingProblem('palette.toggle', chord('Ctrl+R'), false)).toBe('ctrl-key')
    expect(bindingProblem('tab.next', chord('Ctrl+PageDown'), false)).toBeNull()
  })
})

describe('overlaps', () => {
  it('treats a digit as part of the 1-9 range with the same modifiers', () => {
    expect(overlaps(chord('Ctrl+3'), chord('Ctrl+1-9'))).toBe(true)
    expect(overlaps(chord('Ctrl+Shift+3'), chord('Ctrl+1-9'))).toBe(false)
    expect(overlaps(chord('Ctrl+0'), chord('Ctrl+1-9'))).toBe(false)
    expect(overlaps(chord('Ctrl+Shift+K'), chord('shift+ctrl+k'))).toBe(true)
  })
})

describe('usedByMonaco', () => {
  it('knows the Monaco defaults of each platform', () => {
    expect(usedByMonaco(chord('Ctrl+Shift+K'), false)).toBe(true)
    expect(usedByMonaco(chord('Ctrl+Shift+Y'), false)).toBe(false)
    expect(usedByMonaco(chord('Cmd+D', true), true)).toBe(true)
    expect(usedByMonaco(chord('Cmd+D', false), false)).toBe(false)
  })
})

describe('parseScopedChord', () => {
  it('reads a terminal: prefix in any case and writes it back in one form', () => {
    const spec = parseScopedChord(' Terminal:Cmd+K ', true)
    expect(spec).toEqual({ ...chord('Cmd+K', true), terminal: true })
    expect(formatScopedChord(spec as ChordSpec, true)).toBe('terminal:Cmd+K')
    expect(parseScopedChord('Cmd+K', true)).toEqual(chord('Cmd+K', true))
    expect(formatScopedChord(chord('Cmd+K', true), true)).toBe('Cmd+K')
  })

  it('refuses a prefix with no chord and any other prefix', () => {
    expect(parseScopedChord('terminal:', true)).toBeNull()
    expect(parseScopedChord('terminal:Ctrl+Nope', false)).toBeNull()
    expect(parseScopedChord('editor:Cmd+K', true)).toBeNull()
  })

  it('tells chords of a terminal from chords of the whole window', () => {
    const inTerminal = parseScopedChord('terminal:Cmd+D', true) as ChordSpec
    expect(sameScope(inTerminal, chord('Cmd+D', true))).toBe(false)
    expect(sameScope(inTerminal, parseScopedChord('terminal:Cmd+K', true) as ChordSpec)).toBe(true)
    expect(sameScope(chord('Cmd+D', true), chord('Cmd+K', true))).toBe(true)
  })

  it('checks a prefixed binding by the chord after the prefix', () => {
    expect(checkBinding('terminal.clear', 'terminal:Ctrl+Shift+K', false)).toBeNull()
    expect(checkBinding('terminal.clear', 'terminal:Ctrl+K', false)).toBe('ctrl-key')
    expect(checkBinding('terminal.clear', 'terminal:', false)).toBe('invalid')
  })
})

describe('parseKeybindings', () => {
  it('keeps chord strings and nulls, and drops everything else', () => {
    const parsed = parseKeybindings(
      JSON.parse(
        '{"palette.toggle":"Cmd+J","view.toggleRail":null,"history.search":7,' +
          '"workspace.new":"Ctrl+Nope","__proto__":"Ctrl+Shift+X"}',
      ),
    )
    expect({ ...parsed }).toEqual({ 'palette.toggle': 'Cmd+J', 'view.toggleRail': null })
  })

  it('keeps a list of chords, trimmed and without repeats, and drops the entries that do not parse', () => {
    const parsed = parseKeybindings({
      'tab.next': [' Ctrl+Tab ', 'Shift+Cmd+]', 'Ctrl+Tab', 'Ctrl+Nope', 7],
      'pane.splitRight': ['terminal:Cmd+D', 'terminal:', 'Cmd+Alt+\\'],
      'view.zoomIn': ['Ctrl+Nope'],
      'view.zoomOut': [],
      find: Array.from({ length: 12 }, (_, i) => `Ctrl+F${i + 1}`),
    })
    expect({ ...parsed }).toEqual({
      'tab.next': ['Ctrl+Tab', 'Shift+Cmd+]'],
      'pane.splitRight': ['terminal:Cmd+D', 'Cmd+Alt+\\'],
      find: Array.from({ length: CHORDS_PER_COMMAND_MAX }, (_, i) => `Ctrl+F${i + 1}`),
    })
  })

  it('returns an empty map for a non-object', () => {
    expect({ ...parseKeybindings(['Ctrl+K']) }).toEqual({})
    expect({ ...parseKeybindings('Ctrl+K') }).toEqual({})
  })
})

describe('double Shift', () => {
  const shift: TapKey = { key: 'Shift', ctrlKey: false, metaKey: false, altKey: false }
  const other = (key: string, mods: Partial<TapKey> = {}): TapKey => ({ ...shift, key, ...mods })
  const run = (steps: [kind: 'down' | 'up', key: TapKey, at: number][]): number => {
    const detector = doubleShiftDetector()
    let fired = 0
    for (const [kind, key, at] of steps) {
      if (kind === 'down') detector.down(key, at)
      else if (detector.up(key, at)) fired += 1
    }
    return fired
  }

  it('parses Shift+Shift as its own chord and prints it back', () => {
    const spec = chord(DOUBLE_SHIFT)
    expect(formatChord(spec, false)).toBe('Shift+Shift')
    expect(chordText(spec, true)).toBe('⇧⇧')
    expect(chordText(spec, false)).toBe('Shift+Shift')
    expect(specFromEvent(event('Shift', { shiftKey: true }, 'ShiftLeft'))).toBeNull()
  })

  it('refuses Shift on its own or with another modifier', () => {
    expect(parseChord('Shift', false)).toBeNull()
    expect(parseChord('Ctrl+Shift', false)).toBeNull()
    expect(parseChord('Cmd+Shift', true)).toBeNull()
    expect(parseChord('Shift+Shift+Shift', false)).toBeNull()
  })

  it('binds to app commands only, never in the terminal scope or to browser keys', () => {
    expect(bindingProblem('palette.searchEverywhere', chord(DOUBLE_SHIFT), false)).toBeNull()
    expect(bindingProblem('palette.toggle', chord(DOUBLE_SHIFT, true), true)).toBeNull()
    expect(checkBinding('palette.toggle', `terminal:${DOUBLE_SHIFT}`, false)).toBe('invalid')
    expect(checkBinding('browser.reload', DOUBLE_SHIFT, false)).toBe('invalid')
  })

  it('fires on the second of two lone Shift taps close together', () => {
    expect(
      run([
        ['down', shift, 0],
        ['up', shift, 80],
        ['down', shift, 300],
        ['up', shift, 380],
      ]),
    ).toBe(1)
  })

  it('does not fire for a single tap or taps too far apart', () => {
    expect(
      run([
        ['down', shift, 0],
        ['up', shift, 80],
      ]),
    ).toBe(0)
    expect(
      run([
        ['down', shift, 0],
        ['up', shift, 80],
        ['down', shift, 381],
        ['up', shift, 450],
      ]),
    ).toBe(0)
  })

  it('does not fire when Shift is held', () => {
    expect(
      run([
        ['down', shift, 0],
        ['up', shift, 80],
        ['down', shift, 150],
        ['up', shift, 451],
      ]),
    ).toBe(0)
    expect(
      run([
        ['down', shift, 0],
        ['up', shift, 400],
        ['down', shift, 450],
        ['up', shift, 500],
      ]),
    ).toBe(0)
  })

  it('does not count a Shift held with key repeat as a tap', () => {
    const repeats = [30, 60, 90, 120].map((at): [kind: 'down' | 'up', key: TapKey, at: number] => [
      'down',
      { ...shift, repeat: true },
      at,
    ])
    expect(
      run([
        ['down', shift, 0],
        ...repeats,
        ['up', shift, 140],
        ['down', shift, 200],
        ['up', shift, 250],
      ]),
    ).toBe(0)
  })

  it('does not fire when another key comes between or rides on Shift', () => {
    expect(
      run([
        ['down', shift, 0],
        ['up', shift, 80],
        ['down', other('a'), 100],
        ['up', other('a'), 120],
        ['down', shift, 150],
        ['up', shift, 200],
      ]),
    ).toBe(0)
    expect(
      run([
        ['down', shift, 0],
        ['up', shift, 80],
        ['down', shift, 150],
        ['down', other('A'), 160],
        ['up', other('A'), 170],
        ['up', shift, 200],
      ]),
    ).toBe(0)
    expect(
      run([
        ['down', shift, 0],
        ['up', shift, 80],
        ['down', { ...shift, ctrlKey: true }, 150],
        ['up', shift, 200],
      ]),
    ).toBe(0)
  })

  it('does not fire while an input method is composing', () => {
    expect(
      run([
        ['down', shift, 0],
        ['up', shift, 80],
        ['down', { ...shift, isComposing: true }, 150],
        ['up', shift, 200],
      ]),
    ).toBe(0)
  })

  it('fires once for three quick taps and again for a fourth', () => {
    const tap = (at: number): [kind: 'down' | 'up', key: TapKey, at: number][] => [
      ['down', shift, at],
      ['up', shift, at + 50],
    ]
    expect(run([...tap(0), ...tap(100), ...tap(200)])).toBe(1)
    expect(run([...tap(0), ...tap(100), ...tap(200), ...tap(300)])).toBe(2)
  })

  it('starts over after reset', () => {
    const detector = doubleShiftDetector()
    detector.down(shift, 0)
    detector.up(shift, 50)
    detector.reset()
    detector.down(shift, 100)
    expect(detector.up(shift, 150)).toBe(false)
  })
})
