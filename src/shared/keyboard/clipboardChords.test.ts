import { describe, expect, it } from 'vitest'
import { parseChord } from './chordSpec'
import {
  type GuestKeyInput,
  guestClipboardEdit,
  isClipboardEdit,
  normalizeClipboardChords,
} from './clipboardChords'

const linux = {
  copy: parseChord('Ctrl+Shift+C', false),
  paste: parseChord('Ctrl+Shift+V', false),
}

const mac = { copy: parseChord('Cmd+C', true), paste: parseChord('Cmd+V', true) }

function key(over: Partial<GuestKeyInput>): GuestKeyInput {
  return {
    type: 'keyDown',
    key: 'c',
    code: 'KeyC',
    control: false,
    shift: false,
    alt: false,
    meta: false,
    ...over,
  }
}

describe('normalizeClipboardChords', () => {
  it('keeps the copy and paste chords the renderer resolved', () => {
    expect(normalizeClipboardChords(linux, false)).toEqual(linux)
  })

  it('keeps an unbound chord as null', () => {
    expect(normalizeClipboardChords({ copy: null, paste: linux.paste }, false)).toEqual({
      copy: null,
      paste: linux.paste,
    })
  })

  it('refuses a chord that would steal a terminal key', () => {
    const plain = { ctrl: true, shift: false, alt: false, meta: false, key: 'c' }
    expect(normalizeClipboardChords({ copy: plain, paste: null }, false)).toBeNull()
    const bare = { ctrl: false, shift: false, alt: false, meta: false, key: 'v' }
    expect(normalizeClipboardChords({ copy: null, paste: bare }, false)).toBeNull()
  })

  it('refuses malformed payloads', () => {
    expect(normalizeClipboardChords(null, false)).toBeNull()
    expect(normalizeClipboardChords([], false)).toBeNull()
    expect(normalizeClipboardChords({ copy: 'Ctrl+Shift+C', paste: null }, false)).toBeNull()
    expect(
      normalizeClipboardChords(
        { copy: { ctrl: 1, shift: true, alt: false, meta: false, key: 'c' }, paste: null },
        false,
      ),
    ).toBeNull()
    expect(
      normalizeClipboardChords(
        { copy: { ctrl: true, shift: true, alt: false, meta: false, key: 'nope' }, paste: null },
        false,
      ),
    ).toBeNull()
    expect(
      normalizeClipboardChords(
        { copy: { ctrl: true, shift: true, alt: false, meta: false, key: '1-9' }, paste: null },
        false,
      ),
    ).toBeNull()
  })
})

describe('guestClipboardEdit', () => {
  it('maps the copy and paste chords on key down', () => {
    expect(guestClipboardEdit(key({ control: true, shift: true, key: 'C' }), linux, false)).toBe(
      'copy',
    )
    expect(
      guestClipboardEdit(key({ control: true, shift: true, key: 'V', code: 'KeyV' }), linux, false),
    ).toBe('paste')
  })

  it('ignores key up and other keys', () => {
    expect(
      guestClipboardEdit(key({ type: 'keyUp', control: true, shift: true }), linux, false),
    ).toBeNull()
    expect(guestClipboardEdit(key({ control: true }), linux, false)).toBeNull()
    expect(guestClipboardEdit(key({ control: true, shift: true, alt: true }), linux, false)).toBe(
      null,
    )
  })

  it('follows a rebound chord', () => {
    const rebound = { copy: parseChord('Ctrl+Alt+C', false), paste: null }
    expect(guestClipboardEdit(key({ control: true, alt: true }), rebound, false)).toBe('copy')
    expect(guestClipboardEdit(key({ control: true, shift: true }), rebound, false)).toBeNull()
  })

  it('leaves the native Cmd+C and Cmd+V to macOS', () => {
    expect(guestClipboardEdit(key({ meta: true }), mac, true)).toBeNull()
    expect(guestClipboardEdit(key({ meta: true, key: 'v', code: 'KeyV' }), mac, true)).toBeNull()
  })

  it('reads the key from the physical code under another layout', () => {
    expect(
      guestClipboardEdit(key({ control: true, shift: true, key: 'Ї', code: 'KeyC' }), linux, false),
    ).toBe('copy')
  })
})

describe('isClipboardEdit', () => {
  it('accepts only copy and paste', () => {
    expect(isClipboardEdit('copy')).toBe(true)
    expect(isClipboardEdit('paste')).toBe(true)
    expect(isClipboardEdit('cut')).toBe(false)
    expect(isClipboardEdit(undefined)).toBe(false)
  })
})
