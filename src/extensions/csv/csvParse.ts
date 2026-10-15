import Papa from 'papaparse'
import { CSV_LIMITS, type CsvLimits, type CsvTable } from './csvShape'

export function parseTable(
  text: string,
  delimiter: string,
  limits: CsvLimits = CSV_LIMITS,
): CsvTable {
  const parsed = Papa.parse<string[]>(text, {
    delimiter,
    skipEmptyLines: 'greedy',
    preview: limits.rows + 2,
  })
  const lines = parsed.data.filter((row) => Array.isArray(row))
  const [first = [], ...body] = lines
  let widest = 0
  for (const row of lines) widest = Math.max(widest, row.length)
  const width = Math.min(limits.columns, widest)
  const fit = (row: string[]): string[] =>
    Array.from({ length: width }, (_unused, i) => String(row[i] ?? ''))
  return {
    header: fit(first),
    rows: body.slice(0, limits.rows).map(fit),
    rowsCut: body.length > limits.rows,
    columnsCut: widest > limits.columns,
  }
}
