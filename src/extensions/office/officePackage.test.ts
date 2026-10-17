import { strToU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  COLUMNS,
  ROWS,
  longDocument,
  looseOds,
  looseWorkbook,
  nestedIndexZip,
} from '../../../test/fixtures/office/bypasses'
import { probeSheetJS } from '../../../test/fixtures/office/sheetjsProbe'
import {
  deflated,
  docx,
  macroWorkbook,
  paragraph,
  rawZip,
  workbook,
} from '../../../test/fixtures/office/workbooks'
import { readDocument } from './docModel'
import { OFFICE_LIMITS } from './officeLimits'
import { officePackage } from './officePackage'
import { readWorkbook } from './sheetModel'

const SMALL = { ...OFFICE_LIMITS, cells: 100_000 }
const BIG = 'A1:J30000'
const PROBE_MS = 120_000

function names(zip: Uint8Array): string[] {
  return Object.keys(unzipSync(zip)).sort()
}

describe('officePackage', () => {
  it('hands the parser a new zip of only the parts it reads, so it never sees the rest', () => {
    const packed = officePackage(macroWorkbook(), 'sheet', OFFICE_LIMITS)
    expect(names(packed).some((name) => name.endsWith('.bin'))).toBe(false)
    expect(names(packed)).toContain('xl/worksheets/sheet1.xml')
    const ods = officePackage(workbook({ S: [['x']] }, 'ods'), 'sheet', OFFICE_LIMITS)
    const odsParts = ['META-INF/manifest.xml', 'content.xml', 'meta.xml', 'mimetype', 'styles.xml']
    expect(names(ods).every((name) => odsParts.includes(name))).toBe(true)
    expect(names(ods)).toContain('content.xml')
  })

  it(
    'refuses an Index.zip that SheetJS would read as a second file (security review HIGH 1)',
    () => {
      const inner = looseWorkbook('worksheets/sheet1.xml', BIG)
      const bytes = nestedIndexZip(inner)
      expect(readWorkbook(bytes, OFFICE_LIMITS)).toEqual({ ok: false, problem: 'failed' })
      expect(probeSheetJS(bytes).cells).toBeGreaterThanOrEqual(300_000)
      for (const marker of ['objectdata.xml', 'Index/Document.iwa', 'docs/INDEX.ZIP']) {
        const marked = rawZip([
          deflated(marker, strToU8('x')),
          deflated('[Content_Types].xml', strToU8('<Types/>')),
        ])
        expect(readWorkbook(marked, OFFICE_LIMITS), marker).toEqual({
          ok: false,
          problem: 'failed',
        })
      }
    },
    PROBE_MS,
  )

  it('detects the format from the parts, never the name: an ODS named .xlsx is scanned as ODS', () => {
    const bytes = looseOds(`${ROWS}="200000"`, `${COLUMNS}="100"`)
    expect(readWorkbook(bytes, SMALL)).toEqual({ ok: false, problem: 'cells-limit' })
    const notOds = rawZip([
      deflated('META-INF/manifest.xml', strToU8('<manifest/>')),
      deflated('mimetype', strToU8('application/vnd.oasis.opendocument.text')),
    ])
    expect(readWorkbook(notOds, OFFICE_LIMITS)).toEqual({ ok: false, problem: 'failed' })
  })

  it.each([
    ['a sheet outside xl/worksheets', looseWorkbook('data/sheet1.xml', BIG)],
    [
      'a repeated row attribute',
      looseOds(`${ROWS}="1" ${ROWS}="300"`, `${COLUMNS}="1" ${COLUMNS}="1000"`),
    ],
    [
      'an underscore attribute',
      looseOds('number-rows-repeated_x="300"', 'number-columns-repeated_x="1000"'),
    ],
    [
      'a > inside a quoted attribute',
      looseOds(`foo=">" ${ROWS}="300"`, `foo=">" ${COLUMNS}="1000"`),
    ],
    ['an upper-case CONTENT.XML', looseOds(`${ROWS}="300"`, `${COLUMNS}="1000"`, 'CONTENT.XML')],
  ])(
    'refuses %s, which SheetJS expands into cells (security review HIGH 2)',
    (_case, bytes) => {
      expect(readWorkbook(bytes, SMALL)).toEqual({ ok: false, problem: 'cells-limit' })
      expect(probeSheetJS(bytes).cells).toBeGreaterThanOrEqual(300_000)
    },
    PROBE_MS,
  )

  it('refuses a part with more elements than the parser can hold (security review MEDIUM 3)', () => {
    const strings = Array.from({ length: 6_000 }, (_unused, i) => `s${i}`)
    const sst = looseWorkbook('worksheets/sheet1.xml', 'A1', strings)
    expect(readWorkbook(sst, { ...OFFICE_LIMITS, sheetNodes: 10_000 })).toEqual({
      ok: false,
      problem: 'nodes-limit',
    })
    expect(readWorkbook(sst, OFFICE_LIMITS).ok).toBe(true)
  })

  it('refuses a document with more elements than mammoth can hold', async () => {
    const bytes = longDocument(4_000)
    expect(await readDocument(bytes, { ...OFFICE_LIMITS, documentNodes: 10_000 })).toEqual({
      ok: false,
      problem: 'nodes-limit',
    })
    const read = await readDocument(docx({ body: paragraph('kept') }), OFFICE_LIMITS)
    expect(read.ok && read.html).toContain('kept')
  })

  it('keeps an OOXML package for the document viewer only, never an ODS one', () => {
    expect(() => officePackage(workbook({ S: [['x']] }, 'ods'), 'document', OFFICE_LIMITS)).toThrow(
      'failed',
    )
    const doc = officePackage(docx({ body: paragraph('x') }), 'document', OFFICE_LIMITS)
    expect(names(doc)).toContain('word/media/a.png')
  })
})
