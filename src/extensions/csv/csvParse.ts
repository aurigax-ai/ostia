import Papa from 'papaparse'

export const ROWS_MAX = 100_000
export const COLUMNS_MAX = 1_000

export interface CsvTable {
  header: string[]
  rows: string[][]
  rowsCut: boolean
  columnsCut: boolean
}

export function delimiterOf(name: string): string {
  return /\.tsv$/i.test(name) ? '\t' : ','
}

export function parseTable(text: string, delimiter: string): CsvTable {
  const parsed = Papa.parse<string[]>(text, {
    delimiter,
    skipEmptyLines: 'greedy',
    preview: ROWS_MAX + 2,
  })
  const lines = parsed.data.filter((row) => Array.isArray(row))
  const [first = [], ...body] = lines
  let widest = 0
  for (const row of lines) widest = Math.max(widest, row.length)
  const width = Math.min(COLUMNS_MAX, widest)
  const fit = (row: string[]): string[] =>
    Array.from({ length: width }, (_unused, i) => String(row[i] ?? ''))
  return {
    header: fit(first),
    rows: body.slice(0, ROWS_MAX).map(fit),
    rowsCut: body.length > ROWS_MAX,
    columnsCut: widest > COLUMNS_MAX,
  }
}
