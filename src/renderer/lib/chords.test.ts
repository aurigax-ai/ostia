import { describe, expect, it } from 'vitest'
import { type KeyLike, chordLabel, isAppChord, matchChord } from './chords'

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
