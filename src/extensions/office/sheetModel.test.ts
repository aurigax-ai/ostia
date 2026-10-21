import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import {
  encryptedWorkbook,
  externalLinkWorkbook,
  MACRO_MARKER,
  macroWorkbook,
  patched,
  rawZip,
  retyped,
  workbook,
} from '../../../test/fixtures/office/workbooks'
import { OFFICE_LIMITS, type OfficeLimits } from './officeLimits'
import { readWorkbook, type Workbook } from './sheetModel'

function bookOf(bytes: Uint8Array, limits: OfficeLimits = OFFICE_LIMITS): Workbook {
  const result = readWorkbook(bytes, limits)
  if (!result.ok) throw new Error(`not read: ${result.problem}`)
  return result.book
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readWorkbook', () => {
  it('reads values, keeping formatted numbers, dates, booleans, errors and markup as data', () => {
    const bytes = workbook({ Data: [['name', 'share']] }, 'xlsx', (book) => {
      const sheet = book.Sheets.Data
      sheet.A2 = { t: 's', v: '<img src=x onerror=alert(1)>' }
      sheet.B2 = { t: 'n', v: 0.125, z: '0.00%' }
      sheet.C2 = { t: 'n', v: 1234.5, z: '"$"#,##0.00' }
      sheet.D2 = { t: 'n', v: 45000, z: 'yyyy-mm-dd' }
      sheet.E2 = { t: 'b', v: true }
      sheet.F2 = { t: 'e', v: 7, w: '#DIV/0!' }
      sheet.G2 = { t: 'n', v: 0.75, z: 'h:mm' }
      sheet['!ref'] = 'A1:G2'
    })
    const [sheet] = bookOf(bytes).sheets
    expect(sheet.name).toBe('Data')
    expect(sheet.rowCount).toBe(2)
    expect(sheet.columnCount).toBe(7)
    const [text, share, price, date, flag, error, time] = sheet.rows[1]
    expect(text).toBe('<img src=x onerror=alert(1)>')
    expect(share).toEqual({ n: 0.125, w: '12.50%', z: '0.00%' })
    expect(price).toMatchObject({ n: 1234.5, w: '$1,234.50' })
    expect(date).toEqual({ d: new Date(2023, 2, 15).getTime(), p: 'date' })
    expect(flag).toBe(true)
    expect(error).toEqual({ e: '#DIV/0!' })
    expect(time).toMatchObject({ p: 'time' })
  })

  it('gives the same values for xlsx, xlsm and ods', () => {
    const rows = [
      ['city', 'count'],
      ['Taipei', 3],
      ['Hsinchu', 4.5],
    ]
    const expected = bookOf(workbook({ S: rows })).sheets[0].rows
    for (const type of ['xlsm', 'ods'] as const) {
      expect(bookOf(workbook({ S: rows }, type)).sheets[0].rows, type).toEqual(expected)
    }
  })

  it('opens the variant formats: xls, xlt, xlsb, flat ODF and the template types', () => {
    const rows = [['a', 1]]
    const expected = bookOf(workbook({ S: rows })).sheets[0].rows
    const xlsx = workbook({ S: rows })
    const xlsm = workbook({ S: rows }, 'xlsm')
    const ods = workbook({ S: rows }, 'ods')
    const variants = {
      xls: workbook({ S: rows }, 'biff8'),
      xlsb: workbook({ S: rows }, 'xlsb'),
      fods: workbook({ S: rows }, 'fods'),
      xltx: retyped(xlsx, 'sheet.main+xml', 'template.main+xml'),
      xltm: retyped(xlsm, 'sheet.macroEnabled.main+xml', 'template.macroEnabled.main+xml'),
      ots: rawZip(patched(ods, 'mimetype', (text) => `${text}-template`)),
    }
    for (const [type, bytes] of Object.entries(variants)) {
      expect(bookOf(bytes).sheets[0].rows, type).toEqual(expected)
    }
  })

  it('refuses bytes that are no spreadsheet file, as .xlsx or flat ODF', () => {
    const failed = { ok: false, problem: 'failed' }
    const html = new TextEncoder().encode('<table><tr><td>a</td></tr></table>')
    expect(readWorkbook(html, OFFICE_LIMITS)).toEqual(failed)
    expect(
      readWorkbook(new TextEncoder().encode('<?xml version="1.0"?><a/>'), OFFICE_LIMITS),
    ).toEqual(failed)
  })

  it('cuts a huge sheet to the row and column limits and says so', () => {
    const rows = Array.from({ length: 150 }, (_unused, r) =>
      Array.from({ length: 12 }, (_u, c) => r * c),
    )
    const limits = { ...OFFICE_LIMITS, rows: 100, columns: 10 }
    const [sheet] = bookOf(workbook({ Big: rows }), limits).sheets
    expect(sheet.rowCount).toBe(100)
    expect(sheet.rows).toHaveLength(100)
    expect(sheet.rowsCut).toBe(true)
    expect(sheet.columnCount).toBe(10)
    expect(sheet.columnsCut).toBe(true)
    expect(sheet.rows[99][9]).toBe(99 * 9)
  })

  it('reads a sheet larger than the default row limit and stops at it', () => {
    const rows = Array.from({ length: OFFICE_LIMITS.rows + 500 }, (_unused, r) => [r])
    const [sheet] = bookOf(workbook({ Huge: rows })).sheets
    expect(sheet.rowCount).toBe(OFFICE_LIMITS.rows)
    expect(sheet.rowsCut).toBe(true)
    expect(sheet.rows[OFFICE_LIMITS.rows - 1][0]).toBe(OFFICE_LIMITS.rows - 1)
  }, 60_000)

  it('leaves later sheets out once the workbook passes the cell limit', () => {
    const block = Array.from({ length: 20 }, () => [1, 2, 3, 4, 5])
    const book = bookOf(workbook({ A: block, B: block, C: block }), {
      ...OFFICE_LIMITS,
      cells: 150,
    })
    expect(book.sheets.map((sheet) => sheet.name)).toEqual(['A', 'B'])
    expect(book.sheets[1].rowCount).toBe(10)
    expect(book.sheets[1].rowsCut).toBe(true)
    expect(book.cellsCut).toBe(true)
  })

  it('shows visible sheets, counts hidden ones and skips very hidden ones', () => {
    const bytes = workbook({ Shown: [['a']], Hidden: [['b']], Secret: [['c']] }, 'xlsx', (book) => {
      book.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }, { Hidden: 2 }] }
    })
    const book = bookOf(bytes)
    expect(book.sheets.map((sheet) => sheet.name)).toEqual(['Shown'])
    expect(book.hidden).toBe(1)
  })

  it('counts formulas that have no saved value and never shows their text', () => {
    const bytes = workbook({ F: [[2]] }, 'xlsx', (book) => {
      book.Sheets.F.B1 = { t: 'n', f: 'A1*2' } as XLSX.CellObject
      book.Sheets.F.C1 = { t: 'n', f: 'A1*3', v: 6 }
      book.Sheets.F['!ref'] = 'A1:C1'
    })
    const [sheet] = bookOf(bytes).sheets
    expect(sheet.uncached).toBe(1)
    expect(sheet.rows[0]).toEqual([2, null, 6])
    expect(JSON.stringify(sheet)).not.toContain('A1*')
  })

  it('opens a macro workbook without reading its macros', () => {
    const bytes = macroWorkbook()
    const withMacros = XLSX.read(bytes, { type: 'array', bookVBA: true })
    const project = XLSX.CFB.read(withMacros.vbaraw, { type: 'array' })
    const module = XLSX.CFB.find(project, 'Module1')
    expect(new TextDecoder().decode(module.content)).toContain(MACRO_MARKER)
    const result = readWorkbook(bytes, OFFICE_LIMITS)
    expect(result.ok && result.book.sheets[0].rows).toEqual([['macro book', 42]])
    expect(JSON.stringify(result)).not.toContain(MACRO_MARKER)
  })

  it('never fetches an external link or a hyperlink target', () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const bytes = externalLinkWorkbook('http://127.0.0.1:9')
    const parts = unzipSync(bytes)
    const text = (name: string): string => new TextDecoder().decode(parts[name])
    expect(text('xl/externalLinks/_rels/externalLink1.xml.rels')).toContain('remote.xlsx')
    expect(text('xl/worksheets/_rels/sheet1.xml.rels')).toContain('http://127.0.0.1:9/hyperlink')
    const book = bookOf(bytes)
    expect(book.sheets[0].rows[0]).toEqual(['open me', 7])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('names the problem for a password and a malformed file', () => {
    expect(readWorkbook(encryptedWorkbook(), OFFICE_LIMITS)).toEqual({
      ok: false,
      problem: 'encrypted',
    })
    const failed = { ok: false, problem: 'failed' }
    const small = workbook({ S: [['x']] })
    expect(readWorkbook(small.subarray(0, small.length / 2), OFFICE_LIMITS)).toEqual(failed)
    const notABook = workbook({ S: [['x']] }).slice()
    notABook.fill(0x20, 40, notABook.length - 200)
    expect(readWorkbook(notABook, OFFICE_LIMITS)).toEqual(failed)
  })
})
