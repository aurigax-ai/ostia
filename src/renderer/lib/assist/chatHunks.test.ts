import { describe, expect, it } from 'vitest'
import { allDecided, contentWith, editHunks, hunkCounts, settle } from './chatHunks'

const BEFORE = 'a\nb\nc\nd\ne\nf\ng\nh\n'
const AFTER = 'A\nb\nc\nd\ne\nf\ng\nH\nI\n'

describe('editHunks', () => {
  it('splits a change into hunks separated by unchanged lines, with context and line numbers', () => {
    const hunks = editHunks(BEFORE, AFTER)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toMatchObject({
      index: 0,
      oldStart: 1,
      removed: ['a'],
      added: ['A'],
      leading: [],
      trailing: ['b', 'c', 'd'],
    })
    expect(hunks[1]).toMatchObject({
      index: 1,
      oldStart: 8,
      removed: ['h'],
      added: ['H', 'I'],
      leading: ['e', 'f', 'g'],
      trailing: [],
    })
  })

  it('treats a new file as one hunk of added lines and an unchanged file as none', () => {
    expect(editHunks('', 'x\ny\n')).toEqual([
      { index: 0, oldStart: 1, removed: [], added: ['x', 'y'], leading: [], trailing: [] },
    ])
    expect(editHunks(BEFORE, BEFORE)).toEqual([])
  })
})

describe('contentWith', () => {
  it('rebuilds the file from the accepted hunks only, byte for byte', () => {
    expect(contentWith(BEFORE, AFTER, [])).toBe(AFTER)
    expect(contentWith(BEFORE, AFTER, ['accepted', 'rejected'])).toBe('A\nb\nc\nd\ne\nf\ng\nh\n')
    expect(contentWith(BEFORE, AFTER, ['rejected', null])).toBe('a\nb\nc\nd\ne\nf\ng\nH\nI\n')
    expect(contentWith(BEFORE, AFTER, ['rejected', 'rejected'])).toBe(BEFORE)
  })

  it('keeps CRLF line endings and a missing final newline', () => {
    const before = 'one\r\ntwo\r\nthree'
    const after = 'ONE\r\ntwo\r\nthree!'
    expect(contentWith(before, after, ['accepted', 'rejected'])).toBe('ONE\r\ntwo\r\nthree')
    expect(contentWith(before, after, ['rejected', 'accepted'])).toBe('one\r\ntwo\r\nthree!')
  })
})

describe('hunk decisions', () => {
  it('counts only hunks not rejected, and settles undecided hunks as accepted', () => {
    const hunks = editHunks(BEFORE, AFTER)
    expect(hunkCounts(hunks, [])).toEqual({ added: 3, removed: 2 })
    expect(hunkCounts(hunks, [null, 'rejected'])).toEqual({ added: 1, removed: 1 })
    expect(allDecided(2, ['accepted'])).toBe(false)
    expect(allDecided(2, ['accepted', 'rejected'])).toBe(true)
    expect(settle(2, [undefined, 'rejected'])).toEqual(['accepted', 'rejected'])
  })
})
