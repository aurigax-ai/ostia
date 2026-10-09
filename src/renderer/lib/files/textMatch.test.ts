import { describe, expect, it } from 'vitest'
import { textMatcher } from './textMatch'

const opts = { caseSensitive: false, wholeWord: false, regex: false }

describe('textMatcher', () => {
  it('finds a literal text, ignoring case by default', () => {
    expect(textMatcher('a.b', opts)?.('A.B and axb')).toEqual([[0, 3]])
  })

  it('honours match case, whole word and regex', () => {
    expect(textMatcher('Note', { ...opts, caseSensitive: true })?.('note Note')).toEqual([[5, 9]])
    expect(textMatcher('note', { ...opts, wholeWord: true })?.('notes note')).toEqual([[6, 10]])
    expect(textMatcher('n.te', { ...opts, regex: true })?.('nite note')).toEqual([
      [0, 4],
      [5, 9],
    ])
  })

  it('gives no matcher for an empty query or an invalid regex', () => {
    expect(textMatcher('', opts)).toBeNull()
    expect(textMatcher('(', { ...opts, regex: true })).toBeNull()
  })

  it('skips empty matches', () => {
    expect(textMatcher('x*', { ...opts, regex: true })?.('axa')).toEqual([[1, 2]])
  })
})
