import { describe, expect, it, vi } from 'vitest'
import { VIEWER_CELLS_MAX, VIEWER_CSV_MAX } from '../contract/viewerSelection'
import { cellsOutcome, csvField } from './cells'
import { rangeBetween } from './gridSelection'

const range = (r1: number, c1: number, r2: number, c2: number) => ({ r1, c1, r2, c2 })

function source(rows: string[][], extra = {}) {
  return {
    sheet: 'Q4',
    rowOffset: 0,
    text: (row: number, column: number) => rows[row]?.[column] ?? '',
    ...extra,
  }
}

describe('csvField', () => {
  it('quotes only what RFC 4180 needs quoted', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('two\nlines')).toBe('"two\nlines"')
    expect(csvField('car\rreturn')).toBe('"car\rreturn"')
    expect(csvField(' padded ')).toBe(' padded ')
    expect(csvField('台北')).toBe('台北')
    expect(csvField('')).toBe('')
  })
})

describe('cellsOutcome', () => {
  const rows = [
    ['Region', 'Orders', 'Revenue'],
    ['North', '412', '48,210'],
    ['South "S"', '305', '36120'],
  ]

  it('builds the csv of the shown text with the label, size and sheet', () => {
    expect(cellsOutcome(source(rows), range(0, 0, 2, 2))).toEqual({
      kind: 'ready',
      payload: {
        sheet: 'Q4',
        range: 'A1:C3',
        rows: 3,
        columns: 3,
        csv: 'Region,Orders,Revenue\nNorth,412,"48,210"\n"South ""S""",305,36120',
      },
    })
  })

  it('takes only the selected block and counts rows from the offset', () => {
    const outcome = cellsOutcome(source(rows, { rowOffset: 1 }), range(1, 1, 2, 2))
    expect(outcome).toMatchObject({
      kind: 'ready',
      payload: { range: 'B3:C4', rows: 2, columns: 2, csv: '412,"48,210"\n305,36120' },
    })
  })

  it('keeps empty cells of a larger block and refuses a block with nothing in it', () => {
    expect(
      cellsOutcome(source([['a', '']]), rangeBetween({ row: 0, column: 0 }, { row: 0, column: 1 })),
    ).toMatchObject({
      kind: 'ready',
      payload: { csv: 'a,' },
    })
    expect(cellsOutcome(source([['']]), range(0, 0, 0, 0))).toEqual({ kind: 'empty' })
  })

  it('refuses more cells than the cap without reading any of them', () => {
    const text = vi.fn(() => 'x')
    const side = Math.floor(Math.sqrt(VIEWER_CELLS_MAX))
    expect(
      cellsOutcome({ sheet: '', rowOffset: 0, text }, range(0, 0, side - 1, side - 1)).kind,
    ).toBe('ready')
    text.mockClear()
    expect(cellsOutcome({ sheet: '', rowOffset: 0, text }, range(0, 0, side, side)).kind).toBe(
      'too-large',
    )
    expect(text).not.toHaveBeenCalled()
    expect(cellsOutcome({ sheet: '', rowOffset: 0, text }, range(0, 0, 99_999, 999)).kind).toBe(
      'too-large',
    )
  })

  it('refuses a csv over 256 KiB, counted in bytes', () => {
    const wide = '台'.repeat(Math.ceil(VIEWER_CSV_MAX / 3) + 1)
    expect(wide.length).toBeLessThan(VIEWER_CSV_MAX)
    expect(cellsOutcome(source([[wide]]), range(0, 0, 0, 0))).toEqual({ kind: 'too-large' })
    const fits = 'x'.repeat(VIEWER_CSV_MAX)
    expect(cellsOutcome(source([[fits]]), range(0, 0, 0, 0)).kind).toBe('ready')
    expect(cellsOutcome(source([[`${fits}x`]]), range(0, 0, 0, 0)).kind).toBe('too-large')
  })
})
