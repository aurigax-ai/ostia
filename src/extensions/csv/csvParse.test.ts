import { describe, expect, it } from 'vitest'
import { parseTable } from './csvParse'
import { delimiterOf } from './csvShape'

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
    const limits = { rows: 20, columns: 5 }
    const wide = Array.from({ length: limits.columns + 3 }, (_u, i) => `c${i}`).join(',')
    const lines = Array.from({ length: limits.rows + 10 }, (_u, i) => String(i))
    const table = parseTable([wide, ...lines].join('\n'), ',', limits)
    expect(table.rows).toHaveLength(limits.rows)
    expect(table.rows[limits.rows - 1][0]).toBe(String(limits.rows - 1))
    expect(table.header).toHaveLength(limits.columns)
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
