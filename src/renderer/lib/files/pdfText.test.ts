import { describe, expect, it } from 'vitest'
import { countIn, itemLines, itemTexts, pdfMatches } from './pdfText'

describe('itemLines', () => {
  it('joins items into lines at each end of line', () => {
    const items = [
      { str: 'Hello', hasEOL: false },
      { str: ' world', hasEOL: true },
      { str: '', hasEOL: true },
      { str: 'Next line', hasEOL: false },
    ]
    expect(itemLines(items)).toEqual(['Hello world', 'Next line'])
  })

  it('keeps one text per item for the text layer', () => {
    expect(itemTexts([{ str: 'a' }, { hasEOL: true }, { str: 'b' }])).toEqual(['a', '', 'b'])
  })
})

describe('pdfMatches', () => {
  it('counts matches per item, ignoring case, in page order', () => {
    expect(countIn('Needle needle', 'needle')).toBe(2)
    expect(pdfMatches([['needle'], ['none'], ['a NEEDLE', 'needle']], 'needle')).toEqual([
      { page: 1, nth: 0 },
      { page: 3, nth: 0 },
      { page: 3, nth: 1 },
    ])
  })
})
