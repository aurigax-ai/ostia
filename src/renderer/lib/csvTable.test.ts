import { describe, expect, it } from 'vitest'
import { CSV_COLUMNS_MAX, CSV_ROWS_MAX, csvDelimiter, isCsvPath, parseCsv } from './csvTable'

describe('csvTable', () => {
  it('knows its files and their delimiter', () => {
    expect(['a.csv', 'A.CSV', 'a.tsv'].map(isCsvPath)).toEqual([true, true, true])
    expect(['a.csv.md', 'csv', undefined].map(isCsvPath)).toEqual([false, false, false])
    expect(csvDelimiter('a.tsv')).toBe('\t')
    expect(csvDelimiter('a.csv')).toBe(',')
  })

  it('reads quoted cells, embedded newlines and ragged rows into a rectangle', async () => {
    const table = await parseCsv('name,note\n"Lee, A","two\nlines"\nshort\n\nlast,x,extra\n', ',')
    expect(table).toEqual({
      header: ['name', 'note', ''],
      rows: [
        ['Lee, A', 'two\nlines', ''],
        ['short', '', ''],
        ['last', 'x', 'extra'],
      ],
      more: false,
      columnsCut: false,
    })
  })

  it('reads tab-separated text', async () => {
    const table = await parseCsv('a\tb\n1\t2, still b\n', '\t')
    expect(table.header).toEqual(['a', 'b'])
    expect(table.rows).toEqual([['1', '2, still b']])
  })

  it('shows the first 5,000 rows and 100 columns and says there are more', async () => {
    const wide = Array.from({ length: CSV_COLUMNS_MAX + 5 }, (_u, i) => `c${i}`).join(',')
    const lines = Array.from({ length: CSV_ROWS_MAX + 50 }, (_u, i) => `${i},x`)
    const table = await parseCsv([wide, ...lines].join('\n'), ',')
    expect(table.rows).toHaveLength(CSV_ROWS_MAX)
    expect(table.rows[CSV_ROWS_MAX - 1][0]).toBe(String(CSV_ROWS_MAX - 1))
    expect(table.header).toHaveLength(CSV_COLUMNS_MAX)
    expect(table.more).toBe(true)
    expect(table.columnsCut).toBe(true)
  })

  it('gives an empty table for empty text', async () => {
    expect(await parseCsv('', ',')).toEqual({
      header: [],
      rows: [],
      more: false,
      columnsCut: false,
    })
  })
})
