import { describe, expect, it } from 'vitest'
import { itemLines } from './pdfText'

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
})
