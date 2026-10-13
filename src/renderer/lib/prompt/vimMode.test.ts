import { describe, expect, it } from 'vitest'
import {
  type VimCommand,
  applyVimCommand,
  canMoveVertically,
  clampNormal,
  enterNormal,
  parseVimKeys,
} from './vimMode'

function run(keys: string, text: string, caret: number) {
  const command = parseVimKeys(keys)
  if (command === null || command === 'pending') throw new Error(`not a command: ${keys}`)
  return applyVimCommand(command, { text, caret })
}

describe('parseVimKeys', () => {
  it('parses motions, counts and single-key edits', () => {
    expect(parseVimKeys('w')).toEqual({ kind: 'move', motion: 'w', count: 1 })
    expect(parseVimKeys('3l')).toEqual({ kind: 'move', motion: 'l', count: 3 })
    expect(parseVimKeys('0')).toEqual({ kind: 'move', motion: '0', count: 1 })
    expect(parseVimKeys('12x')).toEqual({ kind: 'deleteChar', count: 12 })
    expect(parseVimKeys('u')).toEqual({ kind: 'undo', count: 1 })
    expect(parseVimKeys('A')).toEqual({ kind: 'insert', at: 'A' })
  })

  it('waits for the rest of a count or an operator', () => {
    expect(parseVimKeys('')).toBe('pending')
    expect(parseVimKeys('1')).toBe('pending')
    expect(parseVimKeys('10')).toBe('pending')
    expect(parseVimKeys('d')).toBe('pending')
    expect(parseVimKeys('2c3')).toBe('pending')
  })

  it('multiplies operator counts and reads doubled operators as whole lines', () => {
    expect(parseVimKeys('d2w')).toEqual<VimCommand>({ kind: 'delete', motion: 'w', count: 2 })
    expect(parseVimKeys('2d3w')).toEqual<VimCommand>({ kind: 'delete', motion: 'w', count: 6 })
    expect(parseVimKeys('3dd')).toEqual<VimCommand>({ kind: 'delete', motion: 'line', count: 3 })
    expect(parseVimKeys('cw')).toEqual<VimCommand>({ kind: 'change', motion: 'w', count: 1 })
    expect(parseVimKeys('d$')).toEqual<VimCommand>({ kind: 'delete', motion: '$', count: 1 })
  })

  it('rejects unknown keys and operator pairs it does not support', () => {
    expect(parseVimKeys('z')).toBeNull()
    expect(parseVimKeys('dz')).toBeNull()
    expect(parseVimKeys('dc')).toBeNull()
    expect(parseVimKeys('dj')).toBeNull()
  })
})

describe('motions', () => {
  const text = 'git commit --amend'

  it('moves by words forward, backward and to word ends', () => {
    expect(run('w', text, 0).caret).toBe(4)
    expect(run('2w', text, 0).caret).toBe(11)
    expect(run('w', text, 11).caret).toBe(13)
    expect(run('e', text, 0).caret).toBe(2)
    expect(run('e', text, 2).caret).toBe(9)
    expect(run('b', text, 11).caret).toBe(4)
    expect(run('2b', text, 17).caret).toBe(11)
    expect(run('3b', text, 17).caret).toBe(4)
  })

  it('stays on the line with h, l, 0 and $ and never passes the last character', () => {
    expect(run('h', text, 0).caret).toBe(0)
    expect(run('5h', text, 3).caret).toBe(0)
    expect(run('100l', text, 0).caret).toBe(17)
    expect(run('$', text, 2).caret).toBe(17)
    expect(run('0', text, 9).caret).toBe(0)
    expect(run('$', 'ab\ncd', 0).caret).toBe(1)
    expect(run('l', 'ab\ncd', 1).caret).toBe(1)
  })

  it('moves between lines with j and k, keeping the column where it can', () => {
    const lines = 'first line\nab\nthird line'
    expect(run('j', lines, 6).caret).toBe(12)
    expect(run('2j', lines, 6).caret).toBe(20)
    expect(run('k', lines, 20).caret).toBe(12)
    expect(run('k', lines, 3).caret).toBe(3)
    expect(canMoveVertically(lines, 3, false)).toBe(false)
    expect(canMoveVertically(lines, 3, true)).toBe(true)
    expect(canMoveVertically(lines, 20, true)).toBe(false)
  })
})

describe('edits', () => {
  it('deletes characters with x and a count, not past the line end', () => {
    expect(run('x', 'abc', 1)).toEqual({ text: 'ac', caret: 1, mode: 'normal' })
    expect(run('5x', 'abc\nd', 1)).toEqual({ text: 'a\nd', caret: 0, mode: 'normal' })
  })

  it('deletes words, to the line edges and whole lines', () => {
    expect(run('dw', 'git commit --amend', 4).text).toBe('git --amend')
    expect(run('d2w', 'a b c d', 0).text).toBe('c d')
    expect(run('dw', 'one two\nnext', 4).text).toBe('one \nnext')
    expect(run('db', 'git commit', 8).text).toBe('git it')
    expect(run('d$', 'echo hello', 5)).toEqual({ text: 'echo ', caret: 4, mode: 'normal' })
    expect(run('d0', 'echo hello', 5).text).toBe('hello')
    expect(run('dd', 'one\ntwo\nthree', 5)).toEqual({
      text: 'one\nthree',
      caret: 4,
      mode: 'normal',
    })
    expect(run('2dd', 'one\ntwo\nthree', 0).text).toBe('three')
    expect(run('dd', 'one\ntwo', 5)).toEqual({ text: 'one', caret: 0, mode: 'normal' })
    expect(run('dd', 'only', 2)).toEqual({ text: '', caret: 0, mode: 'normal' })
  })

  it('changes to the end of the word, not the space after it, and enters insert mode', () => {
    expect(run('cw', 'git commit --amend', 4)).toEqual({
      text: 'git  --amend',
      caret: 4,
      mode: 'insert',
    })
    expect(run('c2w', 'a b c', 0).text).toBe(' c')
    expect(run('cc', 'one\ntwo\nthree', 5)).toEqual({
      text: 'one\n\nthree',
      caret: 4,
      mode: 'insert',
    })
    expect(run('C', 'echo hello', 5)).toEqual({ text: 'echo ', caret: 5, mode: 'insert' })
  })

  it('enters insert mode at the caret, after it, at the line edges and on new lines', () => {
    expect(run('i', 'abc', 1)).toEqual({ text: 'abc', caret: 1, mode: 'insert' })
    expect(run('a', 'abc', 1).caret).toBe(2)
    expect(run('A', 'abc\ndef', 1).caret).toBe(3)
    expect(run('I', '  abc', 4).caret).toBe(2)
    expect(run('o', 'abc\ndef', 1)).toEqual({ text: 'abc\n\ndef', caret: 4, mode: 'insert' })
    expect(run('O', 'abc\ndef', 5)).toEqual({ text: 'abc\n\ndef', caret: 4, mode: 'insert' })
  })
})

describe('enterNormal', () => {
  it('steps the caret back one character unless it is at the line start', () => {
    expect(enterNormal({ text: 'abc', caret: 3 })).toEqual({
      text: 'abc',
      caret: 2,
      mode: 'normal',
    })
    expect(enterNormal({ text: 'ab\ncd', caret: 3 }).caret).toBe(3)
    expect(enterNormal({ text: '', caret: 0 }).caret).toBe(0)
  })
})

describe('clampNormal', () => {
  it('keeps the caret on a character of its line', () => {
    expect(clampNormal('abc', 3)).toBe(2)
    expect(clampNormal('ab\n\ncd', 3)).toBe(3)
    expect(clampNormal('', 5)).toBe(0)
  })
})
