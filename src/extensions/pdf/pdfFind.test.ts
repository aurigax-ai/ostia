import { describe, expect, it } from 'vitest'
import {
  countIn,
  findMatches,
  firstMatchFrom,
  matchOffsets,
  seedFromHash,
  stepIndex,
} from './pdfFind'

describe('countIn', () => {
  it('counts without overlap and folds case unless asked', () => {
    expect(countIn('Needle needle', 'needle', false)).toBe(2)
    expect(countIn('Needle needle', 'needle', true)).toBe(1)
    expect(countIn('aaaa', 'aa', false)).toBe(2)
    expect(countIn('anything', '', false)).toBe(0)
    expect(matchOffsets('xx Ab ab', 'ab', false)).toEqual([3, 6])
  })
})

describe('findMatches', () => {
  it('lists matches per page in order and skips pages not read yet', () => {
    const pages = [['needle'], undefined, ['none'], ['a NEEDLE', 'needle']]
    expect(findMatches(pages, 'needle', false)).toEqual([
      { page: 1, nth: 0 },
      { page: 4, nth: 0 },
      { page: 4, nth: 1 },
    ])
    expect(findMatches(pages, 'needle', true)).toEqual([
      { page: 1, nth: 0 },
      { page: 4, nth: 0 },
    ])
  })
})

describe('moving through matches', () => {
  const matches = [
    { page: 1, nth: 0 },
    { page: 3, nth: 0 },
    { page: 3, nth: 1 },
  ]

  it('starts at the first match on or after the page, wrapping to the first', () => {
    expect(firstMatchFrom(matches, 2)).toBe(1)
    expect(firstMatchFrom(matches, 4)).toBe(0)
    expect(firstMatchFrom([], 1)).toBe(-1)
  })

  it('steps both ways with wrap and from no match', () => {
    expect(stepIndex(2, 3, 1)).toBe(0)
    expect(stepIndex(0, 3, -1)).toBe(2)
    expect(stepIndex(-1, 3, 1)).toBe(0)
    expect(stepIndex(-1, 3, -1)).toBe(2)
    expect(stepIndex(-1, 0, 1)).toBe(-1)
  })
})

describe('seedFromHash', () => {
  it('reads the page and the text a search left in the address', () => {
    expect(seedFromHash('#page=4&find=Notes%20and')).toEqual({ page: 4, find: 'Notes and' })
    expect(seedFromHash('')).toEqual({ page: null, find: '' })
    expect(seedFromHash('#page=-2')).toEqual({ page: null, find: '' })
  })
})
