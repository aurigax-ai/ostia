import * as XLSX from 'xlsx'
import { type OfficeLimits, type OfficeProblem, problemOf } from './officeLimits'
import { requirePackage } from './officeZip'

export type DateParts = 'date' | 'time' | 'both'

export type SheetCell =
  | null
  | string
  | number
  | boolean
  | { n: number; w: string; z: string }
  | { d: number; p: DateParts }
  | { e: string }

export interface SheetData {
  name: string
  rows: SheetCell[][]
  rowCount: number
  columnCount: number
  rowsCut: boolean
  columnsCut: boolean
  uncached: number
}

export interface Workbook {
  sheets: SheetData[]
  hidden: number
  sheetsCut: boolean
  cellsCut: boolean
}

export type WorkbookResult = { ok: true; book: Workbook } | { ok: false; problem: OfficeProblem }

function dateParts(format: string): DateParts | null {
  if (/\[[hms]+\]/i.test(format)) return null
  const plain = format.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')
  const date = /[dy]/i.test(plain)
  const time = /[hs]|AM\/PM|A\/P/i.test(plain)
  if (date && time) return 'both'
  if (date) return 'date'
  return time ? 'time' : null
}

function serialToTime(serial: number, date1904: boolean): number {
  const code = XLSX.SSF.parse_date_code(serial, { date1904 })
  const at = new Date(2000, 0, 1, code.H, code.M, code.S, Math.round((code.u ?? 0) * 1000))
  at.setFullYear(code.y, code.m - 1, code.d)
  return at.getTime()
}

function isGeneral(format: string | undefined): boolean {
  return format === undefined || format === 'General'
}

function numberCell(cell: XLSX.CellObject, date1904: boolean): SheetCell {
  const value = cell.v as number
  const format = typeof cell.z === 'string' ? cell.z : undefined
  if (isGeneral(format)) return value
  const parts = format ? dateParts(format) : null
  if (parts) return { d: serialToTime(value, date1904), p: parts }
  return { n: value, w: cell.w ?? String(value), z: format ?? 'General' }
}

function cellOf(cell: XLSX.CellObject | undefined, date1904: boolean): SheetCell | 'uncached' {
  if (!cell) return null
  if (cell.v === undefined || cell.t === 'z') return cell.f ? 'uncached' : null
  switch (cell.t) {
    case 'n':
      return numberCell(cell, date1904)
    case 'b':
      return Boolean(cell.v)
    case 'e':
      return { e: cell.w ?? '#N/A' }
    case 'd':
      return cell.v instanceof Date ? { d: cell.v.getTime(), p: 'both' } : String(cell.v)
    default:
      return String(cell.v)
  }
}

function trimRow(row: SheetCell[]): SheetCell[] {
  let end = row.length
  while (end > 0 && row[end - 1] === null) end--
  return end === row.length ? row : row.slice(0, end)
}

function readSheet(
  name: string,
  sheet: XLSX.WorkSheet,
  date1904: boolean,
  limits: OfficeLimits,
  cellsLeft: number,
): SheetData {
  const range = XLSX.utils.decode_range(sheet['!fullref'] ?? sheet['!ref'] ?? 'A1:A1')
  const fullRows = sheet['!ref'] ? range.e.r + 1 : 0
  const fullColumns = sheet['!ref'] ? range.e.c + 1 : 0
  const columnCount = Math.min(fullColumns, limits.columns)
  const fitRows = columnCount > 0 ? Math.floor(cellsLeft / columnCount) : limits.rows
  const rowCount = Math.min(fullRows, limits.rows, fitRows)
  const data = (sheet['!data'] ?? []) as (XLSX.CellObject | undefined)[][]
  const rows: SheetCell[][] = []
  let uncached = 0
  for (let r = 0; r < rowCount; r++) {
    const source = data[r] ?? []
    const row: SheetCell[] = []
    for (let c = 0; c < Math.min(source.length, columnCount); c++) {
      const cell = cellOf(source[c], date1904)
      if (cell === 'uncached') uncached++
      row.push(cell === 'uncached' ? null : cell)
    }
    rows.push(trimRow(row))
  }
  return {
    name,
    rows,
    rowCount,
    columnCount,
    rowsCut: rowCount < fullRows,
    columnsCut: columnCount < fullColumns,
    uncached,
  }
}

function readBook(bytes: Uint8Array, limits: OfficeLimits): Workbook {
  const book = XLSX.read(bytes, {
    type: 'array',
    dense: true,
    cellDates: false,
    cellFormula: true,
    cellHTML: false,
    cellStyles: false,
    cellNF: true,
    bookVBA: false,
    bookFiles: false,
    sheetRows: limits.rows + 1,
    WTF: false,
  })
  const date1904 = Boolean(book.Workbook?.WBProps?.date1904)
  const states = book.Workbook?.Sheets ?? []
  const visible = book.SheetNames.filter((_name, i) => !states[i]?.Hidden)
  const veryHidden = states.filter((state) => state?.Hidden === 2).length
  const sheets: SheetData[] = []
  let cellsLeft = limits.cells
  for (const name of visible.slice(0, limits.sheets)) {
    if (cellsLeft <= 0) break
    const sheet = readSheet(name, book.Sheets[name], date1904, limits, cellsLeft)
    cellsLeft -= sheet.rowCount * sheet.columnCount
    sheets.push(sheet)
  }
  return {
    sheets,
    hidden: book.SheetNames.length - visible.length - veryHidden,
    sheetsCut: visible.length > limits.sheets,
    cellsCut: cellsLeft <= 0 && sheets.length < Math.min(visible.length, limits.sheets),
  }
}

const FLAT_ODS =
  /<office:document[\s>][^>]*office:mimetype="application\/vnd\.oasis\.opendocument\.spreadsheet(?:-template)?"/

function isFlatOds(bytes: Uint8Array): boolean {
  return FLAT_ODS.test(new TextDecoder().decode(bytes.subarray(0, 16 * 1024)))
}

export function readWorkbook(bytes: Uint8Array, limits: OfficeLimits): WorkbookResult {
  try {
    if (!isFlatOds(bytes)) requirePackage(bytes)
    return { ok: true, book: readBook(bytes, limits) }
  } catch (error) {
    return { ok: false, problem: problemOf(error) }
  }
}
