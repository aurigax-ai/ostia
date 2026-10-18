export const CSV_LIMITS = { rows: 100_000, columns: 1_000 }

export type CsvLimits = typeof CSV_LIMITS

export interface CsvTable {
  header: string[]
  rows: string[][]
  rowsCut: boolean
  columnsCut: boolean
}

export function delimiterOf(name: string): string {
  return /\.tsv$/i.test(name) ? '\t' : ','
}
