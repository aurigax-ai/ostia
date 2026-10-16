import { describe, expect, it } from 'vitest'
import { columnName, columnWidths, rowLabelWidth, textWidth } from './gridLayout'

describe('gridLayout', () => {
  it('sizes columns in characters from the header and the first rows, wide characters double', () => {
    expect(textWidth('台北')).toBe(4)
    const rows = [
      ['a', 'x'.repeat(100)],
      ['bbbbbb', 'y'],
    ]
    expect(columnWidths(['A', 'B'], 2, (row, column) => rows[row][column])).toEqual([8, 50])
    expect(columnWidths(['A'], 0, () => '')).toEqual([5])
    expect(rowLabelWidth(100_000)).toBe(8)
  })

  it('names columns the way spreadsheets do', () => {
    expect([0, 25, 26, 51, 52, 701, 702, 999].map(columnName)).toEqual([
      'A',
      'Z',
      'AA',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
      'ALL',
    ])
  })
})
