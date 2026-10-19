import { describe, expect, it } from 'vitest'
import {
  decodeRangeArea,
  elementCount,
  hyperlinkCells,
  odsCells,
  sheetjsTagAttributes,
} from './xmlScans'

const ROW = 'table:table-row'
const CELL = 'table:table-cell'

function row(attributes: string, cells: string): string {
  return `<${ROW} ${attributes}>${cells}</${ROW}>`
}

function cell(attributes: string): string {
  return `<${CELL} ${attributes} office:value-type="string"><text:p>x</text:p></${CELL}>`
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

describe('sheetjsTagAttributes', () => {
  it('keeps the last of a repeated attribute, as SheetJS parsexmltag does', () => {
    expect(sheetjsTagAttributes('<c ref="A1" ref="A1:Z9"/>').ref).toBe('A1:Z9')
  })

  it('cuts an unprefixed name at an underscore and also stores it lower-cased', () => {
    const tag = sheetjsTagAttributes('<r number-rows-repeated_x="9" REF="B2"/>')
    expect(tag['number-rows-repeated']).toBe('9')
    expect(tag.ref).toBe('B2')
  })

  it('drops the prefix, but an ext attribute never replaces one already set', () => {
    const tag = sheetjsTagAttributes('<c table:value="1" calcext:value="2" x:other="3"/>')
    expect(tag.value).toBe('1')
    expect(tag.other).toBe('3')
  })
})

describe('hyperlinkCells', () => {
  it('charges every hyperlink range in a part, by its last ref', () => {
    expect(
      hyperlinkCells(
        '<hyperlinks><hyperlink ref="A1:B5" r:id="rId1"/><x:hyperlink r:id="r2" ref="C1"/><hyperlink ref="A1" ref="A1:J10"/></hyperlinks>',
      ),
    ).toBe(10 + 1 + 100)
  })
})

describe('odsCells', () => {
  it('charges repeated rows times repeated columns where SheetJS makes cells', () => {
    const text = [
      row('table:number-rows-repeated="10"', cell('table:number-columns-repeated="20"')),
      row(
        'table:number-rows-repeated="1048000"',
        `<${CELL} table:number-columns-repeated="1024"/>`,
      ),
      row('', `<${CELL} office:value-type="string" table:string-value="x"/>`),
    ].join('')
    expect(odsCells(text)).toBe(10 * 20 + 1 + 1)
  })

  it('reads repeats SheetJS reads: a repeated attribute, an underscore name, a quoted >, an upper-case name', () => {
    expect(
      odsCells(row('table:number-rows-repeated="1" table:number-rows-repeated="300"', cell(''))),
    ).toBe(300)
    expect(
      odsCells(row('number-rows-repeated_x="300"', cell('number-columns-repeated_x="4"'))),
    ).toBe(1200)
    expect(odsCells(row('foo=">" table:number-rows-repeated="300"', cell('foo=">"')))).toBe(300)
    expect(odsCells(row('table:NUMBER-ROWS-REPEATED="300"', cell('')))).toBe(300)
  })

  it('charges a closing cell tag with the last cell tag, as SheetJS does for stray closes', () => {
    const text = `<${ROW} table:number-rows-repeated="100">${cell('table:number-columns-repeated="10"')}</${CELL}></${CELL}></${ROW}>`
    expect(odsCells(text)).toBe(3 * 1000)
  })

  it('skips comments and a doctype the way SheetJS does', () => {
    expect(odsCells(`<!-- ${row('table:number-rows-repeated="999"', cell(''))} -->`)).toBe(0)
  })
})

describe('elementCount', () => {
  it('counts start tags only', () => {
    expect(elementCount('<?xml version="1.0"?><!-- c --><a><b/><c>t</c></a>')).toBe(3)
  })
})
