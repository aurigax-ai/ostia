import { describe, expect, it } from 'vitest'
import {
  activeCell,
  clampCell,
  extendTo,
  type GridMetrics,
  movedCell,
  moveSelection,
  rangeBetween,
  rangeColumns,
  rangeContains,
  rangeLabel,
  rangeRect,
  rangeRows,
  sameRange,
  selectAll,
  selectCell,
  selectHeader,
  selectionRange,
} from './gridSelection'

const SIZE = { rowCount: 10, columnCount: 5 }
const at = (row: number, column: number) => ({ row, column })
const OPTIONS = { size: SIZE, page: 4, ctrl: false }

describe('range math', () => {
  it('orders the corners whatever the drag direction', () => {
    expect(rangeBetween(at(4, 3), at(1, 0))).toEqual({ r1: 1, c1: 0, r2: 4, c2: 3 })
    const range = rangeBetween(at(1, 1), at(3, 2))
    expect(rangeRows(range)).toBe(3)
    expect(rangeColumns(range)).toBe(2)
    expect(rangeContains(range, 2, 2)).toBe(true)
    expect(rangeContains(range, 0, 1)).toBe(false)
    expect(rangeContains(range, 2, 3)).toBe(false)
  })

  it('compares ranges and null', () => {
    expect(sameRange(null, null)).toBe(true)
    expect(sameRange(null, rangeBetween(at(0, 0), at(0, 0)))).toBe(false)
    expect(sameRange(rangeBetween(at(0, 0), at(1, 1)), rangeBetween(at(1, 1), at(0, 0)))).toBe(true)
  })

  it('labels ranges the way spreadsheets do, one cell without a colon, with a row offset', () => {
    expect(rangeLabel(rangeBetween(at(0, 0), at(2, 2)))).toBe('A1:C3')
    expect(rangeLabel(rangeBetween(at(4, 27), at(4, 27)))).toBe('AB5')
    expect(rangeLabel(rangeBetween(at(0, 1), at(2, 1)), 1)).toBe('B2:B4')
  })

  it('clamps a cell into the grid and into an empty one', () => {
    expect(clampCell(at(-3, 99), SIZE)).toEqual(at(0, 4))
    expect(clampCell(at(5, 5), { rowCount: 0, columnCount: 0 })).toEqual(at(0, 0))
  })
})

describe('selection shapes', () => {
  it('extends from the anchor, and from the active cell when nothing is selected', () => {
    const first = selectCell(at(2, 2))
    const grown = extendTo(first, at(2, 2), at(4, 0))
    expect(selectionRange(grown, SIZE)).toEqual({ r1: 2, c1: 0, r2: 4, c2: 2 })
    expect(selectionRange(extendTo(grown, at(4, 0), at(0, 4)), SIZE)).toEqual({
      r1: 0,
      c1: 2,
      r2: 2,
      c2: 4,
    })
    expect(selectionRange(extendTo(null, at(1, 1), at(2, 3)), SIZE)).toEqual({
      r1: 1,
      c1: 1,
      r2: 2,
      c2: 3,
    })
  })

  it('selects whole columns and rows, and extends them by header', () => {
    const column = selectHeader('columns', 2, null)
    expect(selectionRange(column, SIZE)).toEqual({ r1: 0, c1: 2, r2: 9, c2: 2 })
    expect(activeCell(column)).toEqual(at(0, 2))
    expect(selectionRange(selectHeader('columns', 4, column), SIZE)).toEqual({
      r1: 0,
      c1: 2,
      r2: 9,
      c2: 4,
    })
    const row = selectHeader('rows', 3, null)
    expect(selectionRange(row, SIZE)).toEqual({ r1: 3, c1: 0, r2: 3, c2: 4 })
    expect(selectionRange(selectHeader('rows', 1, row), SIZE)).toEqual({
      r1: 1,
      c1: 0,
      r2: 3,
      c2: 4,
    })
    expect(selectionRange(selectHeader('rows', 1, column), SIZE)).toEqual({
      r1: 1,
      c1: 0,
      r2: 1,
      c2: 4,
    })
  })

  it('selects everything', () => {
    expect(selectionRange(selectAll(SIZE), SIZE)).toEqual({ r1: 0, c1: 0, r2: 9, c2: 4 })
  })
})

describe('keyboard moves', () => {
  it('moves one cell and clamps at the edges', () => {
    expect(movedCell(at(0, 0), 'ArrowUp', OPTIONS)).toEqual(at(0, 0))
    expect(movedCell(at(0, 0), 'ArrowDown', OPTIONS)).toEqual(at(1, 0))
    expect(movedCell(at(9, 4), 'ArrowRight', OPTIONS)).toEqual(at(9, 4))
    expect(movedCell(at(2, 2), 'ArrowLeft', OPTIONS)).toEqual(at(2, 1))
  })

  it('pages, goes to the row ends and, with Ctrl, to the grid corners', () => {
    expect(movedCell(at(2, 2), 'PageDown', OPTIONS)).toEqual(at(6, 2))
    expect(movedCell(at(8, 2), 'PageDown', OPTIONS)).toEqual(at(9, 2))
    expect(movedCell(at(2, 2), 'PageUp', OPTIONS)).toEqual(at(0, 2))
    expect(movedCell(at(5, 2), 'Home', OPTIONS)).toEqual(at(5, 0))
    expect(movedCell(at(5, 2), 'End', OPTIONS)).toEqual(at(5, 4))
    expect(movedCell(at(5, 2), 'Home', { ...OPTIONS, ctrl: true })).toEqual(at(0, 0))
    expect(movedCell(at(5, 2), 'End', { ...OPTIONS, ctrl: true })).toEqual(at(9, 4))
  })

  it('a plain move selects the moved-to cell, Shift keeps the anchor', () => {
    const start = selectCell(at(1, 1))
    const moved = moveSelection(start, at(1, 1), 'ArrowDown', false, OPTIONS)
    expect(selectionRange(moved, SIZE)).toEqual({ r1: 2, c1: 1, r2: 2, c2: 1 })
    const grown = moveSelection(moved, at(2, 1), 'ArrowRight', true, OPTIONS)
    const more = moveSelection(grown, at(2, 2), 'ArrowDown', true, OPTIONS)
    expect(selectionRange(more, SIZE)).toEqual({ r1: 2, c1: 1, r2: 3, c2: 2 })
    const back = moveSelection(more, at(3, 2), 'ArrowUp', true, OPTIONS)
    expect(selectionRange(moveSelection(back, at(2, 2), 'ArrowUp', true, OPTIONS), SIZE)).toEqual({
      r1: 1,
      c1: 1,
      r2: 2,
      c2: 2,
    })
  })

  it('starts from the active cell when nothing is selected', () => {
    const grown = moveSelection(null, at(3, 3), 'ArrowRight', true, OPTIONS)
    expect(selectionRange(grown, SIZE)).toEqual({ r1: 3, c1: 3, r2: 3, c2: 4 })
    expect(selectionRange(moveSelection(null, at(3, 3), 'ArrowUp', false, OPTIONS), SIZE)).toEqual({
      r1: 2,
      c1: 3,
      r2: 2,
      c2: 3,
    })
  })

  it('turns a header selection into cells before Shift extends it, and moves from its first cell', () => {
    const column = selectHeader('columns', 1, null)
    const grown = moveSelection(column, at(0, 1), 'ArrowRight', true, OPTIONS)
    expect(selectionRange(grown, SIZE)).toEqual({ r1: 0, c1: 1, r2: 9, c2: 2 })
    expect(
      selectionRange(moveSelection(column, at(0, 1), 'ArrowDown', false, OPTIONS), SIZE),
    ).toEqual({ r1: 1, c1: 1, r2: 1, c2: 1 })
  })
})

describe('rangeRect', () => {
  const metrics: GridMetrics = {
    origin: { x: 100, y: 50 },
    scroll: { left: 0, top: 0 },
    viewport: { width: 400, height: 200 },
    labelWidth: 40,
    headerHeight: 20,
    rowHeight: 20,
    columnStarts: [0, 80, 160, 240],
    columnWidths: [80, 80, 80, 80],
  }

  it('is the bounding box of the cells in page pixels', () => {
    expect(rangeRect({ r1: 1, c1: 1, r2: 2, c2: 2 }, metrics)).toEqual({
      x: 220,
      y: 90,
      width: 160,
      height: 40,
    })
  })

  it('follows the scroll position', () => {
    const scrolled = { ...metrics, scroll: { left: 40, top: 20 } }
    expect(rangeRect({ r1: 1, c1: 1, r2: 1, c2: 1 }, scrolled)).toEqual({
      x: 180,
      y: 70,
      width: 80,
      height: 20,
    })
  })

  it('is clipped to the visible body, under the sticky header and labels', () => {
    const scrolled = { ...metrics, scroll: { left: 100, top: 100 } }
    expect(rangeRect({ r1: 0, c1: 0, r2: 99, c2: 3 }, scrolled)).toEqual({
      x: 140,
      y: 70,
      width: 220,
      height: 180,
    })
    expect(rangeRect({ r1: 0, c1: 0, r2: 1, c2: 0 }, scrolled).height).toBe(0)
  })
})
