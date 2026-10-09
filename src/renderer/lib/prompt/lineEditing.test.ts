import { describe, expect, it } from 'vitest'
import { type KeyLike, applyLineEdit, lineEditOp, shellKeyBytes } from './lineEditing'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code: /^[a-z]$/.test(k) ? `Key${k.toUpperCase()}` : undefined,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
})

describe('lineEditOp', () => {
  it('maps readline keys the editor handles itself', () => {
    expect(lineEditOp(key('a', { ctrlKey: true }))).toBe('home')
    expect(lineEditOp(key('e', { ctrlKey: true }))).toBe('end')
    expect(lineEditOp(key('w', { ctrlKey: true }))).toBe('killWordBack')
    expect(lineEditOp(key('p', { ctrlKey: true }))).toBe('historyPrev')
    expect(lineEditOp(key('l', { ctrlKey: true }))).toBe('clearScreen')
    expect(lineEditOp(key('b', { altKey: true }))).toBe('wordBack')
  })

  it('reads the physical key so a non-Latin layout still maps', () => {
    expect(lineEditOp({ ...key('ф', { ctrlKey: true }), code: 'KeyA' })).toBe('home')
  })

  it('ignores shifted, meta and AltGr combinations and keys it does not own', () => {
    expect(lineEditOp(key('a', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(lineEditOp(key('a', { metaKey: true }))).toBeNull()
    expect(lineEditOp(key('a', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(lineEditOp(key('r', { ctrlKey: true }))).toBeNull()
    expect(lineEditOp(key('a'))).toBeNull()
  })
})

describe('shellKeyBytes', () => {
  it('encodes keys that hand off to the shell’s own widgets', () => {
    expect(shellKeyBytes(key('r', { ctrlKey: true }))).toBe('\x12')
    expect(shellKeyBytes(key('t', { ctrlKey: true }))).toBe('\x14')
    expect(shellKeyBytes(key('c', { altKey: true }))).toBe('\x1bc')
    expect(shellKeyBytes({ ...key('.', { altKey: true }), code: 'Period' })).toBe('\x1b.')
  })

  it('leaves copy, paste, cut and undo to the text field', () => {
    for (const k of ['c', 'v', 'x', 'z'])
      expect(shellKeyBytes(key(k, { ctrlKey: true }))).toBeNull()
    expect(shellKeyBytes(key('r', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(shellKeyBytes(key('r'))).toBeNull()
  })
})

describe('applyLineEdit', () => {
  const buf = (text: string, caret: number) => ({ text, caret })

  it('moves within the current line of a multi-line draft', () => {
    expect(applyLineEdit('home', buf('ls\necho hi', 8), '').caret).toBe(3)
    expect(applyLineEdit('end', buf('ls -la\necho', 1), '').caret).toBe(6)
  })

  it('moves by words', () => {
    expect(applyLineEdit('wordBack', buf('git commit -m', 13), '').caret).toBe(12)
    expect(applyLineEdit('wordForward', buf('git commit', 0), '').caret).toBe(3)
  })

  it('kills to the ends of the line and by whitespace word, returning the killed text', () => {
    expect(applyLineEdit('killEnd', buf('echo hello', 4), '')).toEqual({
      text: 'echo',
      caret: 4,
      killed: ' hello',
    })
    expect(applyLineEdit('killStart', buf('echo hello', 5), '')).toEqual({
      text: 'hello',
      caret: 0,
      killed: 'echo ',
    })
    expect(applyLineEdit('killWordBack', buf('cd ~/a/b ', 9), '')).toEqual({
      text: 'cd ',
      caret: 3,
      killed: '~/a/b ',
    })
  })

  it('joins the next line when killing at the end of a line', () => {
    expect(applyLineEdit('killEnd', buf('a\nb', 1), '').text).toBe('ab')
  })

  it('yanks the last killed text at the caret', () => {
    expect(applyLineEdit('yank', buf('echo ', 5), 'hello')).toEqual({
      text: 'echo hello',
      caret: 10,
      killed: null,
    })
  })

  it('deletes characters on either side of the caret', () => {
    expect(applyLineEdit('deleteChar', buf('abc', 1), '').text).toBe('ac')
    expect(applyLineEdit('backspace', buf('abc', 1), '')).toMatchObject({ text: 'bc', caret: 0 })
    expect(applyLineEdit('backspace', buf('abc', 0), '').text).toBe('abc')
  })
})
