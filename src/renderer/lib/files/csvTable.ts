export const CSV_ROWS_MAX = 5_000
export const CSV_COLUMNS_MAX = 100

export interface CsvTableData {
  header: string[]
  rows: string[][]
  more: boolean
  columnsCut: boolean
}

export function isCsvPath(path: string | undefined): boolean {
  return path !== undefined && /\.(csv|tsv)$/i.test(path)
}

export function csvDelimiter(path: string): string {
  return /\.tsv$/i.test(path) ? '\t' : ','
}

export async function parseCsv(text: string, delimiter: string): Promise<CsvTableData> {
  const { default: Papa } = await import('papaparse')
  const parsed = Papa.parse<string[]>(text, {
    delimiter,
    skipEmptyLines: 'greedy',
    preview: CSV_ROWS_MAX + 2,
  })
  const all = parsed.data.filter((row) => Array.isArray(row))
  const [first = [], ...body] = all
  const width = Math.min(
    CSV_COLUMNS_MAX,
    all.reduce((max, row) => Math.max(max, row.length), 0),
  )
  const fit = (row: string[]): string[] =>
    Array.from({ length: width }, (_unused, i) => String(row[i] ?? ''))
  return {
    header: fit(first),
    rows: body.slice(0, CSV_ROWS_MAX).map(fit),
    more: body.length > CSV_ROWS_MAX,
    columnsCut: all.some((row) => row.length > CSV_COLUMNS_MAX),
  }
}
