export const PAGE_LINES = 400
export const WINDOW_LINES = 3 * PAGE_LINES

interface RowLike {
  readonly isWrapped: boolean
  translateToString(trimRight?: boolean): string
}

export interface RowsLike {
  readonly length: number
  getLine(y: number): RowLike | undefined
}

export function windowStart(target: number, first: number, end: number): number {
  const latest = Math.max(first, end - WINDOW_LINES)
  return Math.min(latest, Math.max(first, target - PAGE_LINES))
}

function startsLine(rows: RowsLike, y: number): boolean {
  return y === 0 || !rows.getLine(y)?.isWrapped
}

function lastContentRow(rows: RowsLike): number {
  let last = rows.length - 1
  while (last >= 0 && (rows.getLine(last)?.translateToString(true).trim() ?? '') === '') last--
  return last
}

export function logicalLinesFrom(rows: RowsLike, fromRow: number): number {
  const last = lastContentRow(rows)
  let count = 0
  for (let y = Math.max(0, fromRow); y <= last; y++) if (startsLine(rows, y)) count++
  return count
}

export function rowOfLine(rows: RowsLike, index: number): number {
  let seen = -1
  for (let y = 0; y < rows.length; y++) {
    if (startsLine(rows, y)) seen++
    if (seen === index) return y
  }
  return Math.max(0, rows.length - 1)
}

export function lineAtRow(rows: RowsLike, row: number): number {
  let seen = -1
  const stop = Math.min(row, rows.length - 1)
  for (let y = 0; y <= stop; y++) if (startsLine(rows, y)) seen++
  return Math.max(0, seen)
}
