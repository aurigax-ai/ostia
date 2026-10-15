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
