import { describe, expect, it } from 'vitest'
import { probeSheetJS } from '../../../test/fixtures/office/sheetjsProbe'
import { hyperlinkRange, odsRepeats } from '../../../test/fixtures/office/workbooks'
import { OFFICE_LIMITS } from './officeLimits'
import { readWorkbook } from './sheetModel'
import { type CellBudget, decodeRangeArea, hyperlinkScan, odsRepeatScan } from './xmlScans'

const SMALL = { ...OFFICE_LIMITS, cells: 100_000 }

function feed(scan: ReturnType<typeof hyperlinkScan>, text: string, size = 7): void {
  const bytes = new TextEncoder().encode(text)
  for (let at = 0; at < bytes.length; at += size) {
    scan(bytes.subarray(at, at + size), at + size >= bytes.length)
  }
}

describe('decodeRangeArea', () => {
  it('reads ranges the way SheetJS safe_decode_range does, unclamped', () => {
    expect(decodeRangeArea('A1')).toBe(1)
    expect(decodeRangeArea('A1:B3')).toBe(6)
    expect(decodeRangeArea('B3:A1')).toBe(0)
    expect(decodeRangeArea('A1:XFD1048576')).toBe(16_384 * 1_048_576)
    expect(decodeRangeArea('A1:ZZZZZZZZZZZZ999999999999')).toBeGreaterThan(1e20)
  })
})

describe('hyperlinkScan', () => {
  it('charges each hyperlink range, also across chunk boundaries', () => {
    const budget: CellBudget = { left: 100 }
    feed(
      hyperlinkScan(budget),
      '<sheetData/><hyperlinks><hyperlink ref="A1:B5" r:id="rId1"/><x:hyperlink r:id="r2" ref="C1"/></hyperlinks>',
    )
    expect(budget.left).toBe(89)
    expect(() => feed(hyperlinkScan({ left: 100 }), '<hyperlink ref="A1:J11"/>')).toThrow(
      'cells-limit',
    )
  })

  it('refuses a small xlsx whose hyperlink range SheetJS fills with cells (new in this review)', () => {
    const bytes = hyperlinkRange('A1:J30000')
    expect(bytes.length).toBeLessThan(8 * 1024)
    expect(readWorkbook(bytes, 'xlsx', SMALL)).toEqual({ ok: false, problem: 'cells-limit' })
    expect(probeSheetJS(bytes).cells).toBeGreaterThanOrEqual(300_000)
    expect(readWorkbook(hyperlinkRange('A1:XFD1048576'), 'xlsx', OFFICE_LIMITS)).toEqual({
      ok: false,
      problem: 'cells-limit',
    })
  }, 120_000)
})

describe('odsRepeatScan', () => {
  it('charges repeated rows times repeated columns of cells with content', () => {
    const budget: CellBudget = { left: 1_000 }
    feed(
      odsRepeatScan(budget),
      [
        '<table:table-row table:number-rows-repeated="10">',
        '<table:table-cell table:number-columns-repeated="20"><text:p>1</text:p></table:table-cell>',
        '<table:table-cell table:number-columns-repeated="999"/>',
        '</table:table-row>',
        '<table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>',
        '<table:table-row><table:table-cell office:value-type="string" table:string-value="x"/></table:table-row>',
      ].join(''),
    )
    expect(budget.left).toBe(1_000 - 200 - 1)
  })

  it('refuses a small ods whose repeats SheetJS expands into cells (#894 review MEDIUM 3)', () => {
    const bytes = odsRepeats(300, 1_000)
    expect(bytes.length).toBeLessThan(4 * 1024)
    expect(readWorkbook(bytes, 'ods', SMALL)).toEqual({ ok: false, problem: 'cells-limit' })
    expect(probeSheetJS(bytes).cells).toBeGreaterThanOrEqual(300_000)
    expect(readWorkbook(odsRepeats(1_000_000, 16_384), 'ods', OFFICE_LIMITS)).toEqual({
      ok: false,
      problem: 'cells-limit',
    })
  }, 120_000)
})
