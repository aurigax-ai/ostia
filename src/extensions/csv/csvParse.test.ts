import { describe, expect, it } from 'vitest'
import { parseTable } from './csvParse'
import { COLUMNS_MAX, ROWS_MAX, delimiterOf } from './csvShape'

describe('parseTable', () => {
  it('reads quoted cells, embedded newlines and ragged rows into a rectangle', () => {
    expect(parseTable('name,note\n"Lee, A","two\nlines"\nshort\n\nlast,x,extra\n', ',')).toEqual({
      header: ['name', 'note', ''],
      rows: [
        ['Lee, A', 'two\nlines', ''],
        ['short', '', ''],
        ['last', 'x', 'extra'],
      ],
      rowsCut: false,
      columnsCut: false,
    })
  })

  it('keeps markup and formulas as text', () => {
    const table = parseTable('a,b\n<img src=x onerror=alert(1)>,"=HYPERLINK(""http://x"")"\n', ',')
    expect(table.rows[0]).toEqual(['<img src=x onerror=alert(1)>', '=HYPERLINK("http://x")'])
  })

  it('stops at the row and column limits and says so', () => {
    const wide = Array.from({ length: COLUMNS_MAX + 3 }, (_u, i) => `c${i}`).join(',')
    const lines = Array.from({ length: ROWS_MAX + 10 }, (_u, i) => String(i))
    const table = parseTable([wide, ...lines].join('\n'), ',')
    expect(table.rows).toHaveLength(ROWS_MAX)
    expect(table.rows[ROWS_MAX - 1][0]).toBe(String(ROWS_MAX - 1))
    expect(table.header).toHaveLength(COLUMNS_MAX)
    expect(table.rowsCut).toBe(true)
    expect(table.columnsCut).toBe(true)
  })

  it('reads tab-separated files by their name', () => {
    expect(delimiterOf('a.TSV')).toBe('\t')
    expect(delimiterOf('a.csv')).toBe(',')
    expect(parseTable('a\tb\n1\t2, still b\n', '\t').rows).toEqual([['1', '2, still b']])
    expect(parseTable('', ',')).toEqual({ header: [], rows: [], rowsCut: false, columnsCut: false })
  })
})
