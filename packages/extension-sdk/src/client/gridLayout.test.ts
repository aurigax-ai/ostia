import { describe, expect, it } from 'vitest'
import {
  columnName,
  columnStarts,
  columnWidths,
  revealOffset,
  rowLabelWidth,
  textWidth,
} from './gridLayout'

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

  it('adds widths into column starts', () => {
    expect(columnStarts([10, 20, 5])).toEqual([0, 10, 30])
    expect(columnStarts([])).toEqual([])
  })

  it('scrolls the least that brings an item into view', () => {
    expect(revealOffset(100, 20, 0, 200)).toBe(0)
    expect(revealOffset(100, 20, 150, 200)).toBe(100)
    expect(revealOffset(400, 20, 0, 200)).toBe(220)
    expect(revealOffset(10, 20, 0, 5)).toBe(25)
    expect(revealOffset(0, 20, 0, 0)).toBe(20)
  })
})
