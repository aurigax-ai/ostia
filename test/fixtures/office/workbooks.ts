import { Deflate, deflateSync, strToU8, unzipSync } from 'fflate'
import * as XLSX from 'xlsx'

export interface ZipEntry {
  name: string
  method: 0 | 8
  data: Uint8Array
  size: number
}

export const MACRO_MARKER = 'OSTIA_MACRO_MARKER_Shell_touch'

export function workbook(
  sheets: Record<string, unknown[][]>,
  bookType: XLSX.BookType = 'xlsx',
  setup?: (book: XLSX.WorkBook) => void,
): Uint8Array {
  const book = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name)
  }
  setup?.(book)
  const out = XLSX.write(book, { type: 'array', bookType, bookVBA: true, compression: true })
  return new Uint8Array(out as ArrayBuffer)
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff]
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

export function rawZip(entries: ZipEntry[], directory = entries.map((_entry, i) => i)): Uint8Array {
  const parts: number[][] = []
  const offsets: number[] = []
  let offset = 0
  const push = (bytes: number[] | Uint8Array): void => {
    parts.push(Array.from(bytes))
    offset += bytes.length
  }
  for (const entry of entries) {
    const name = strToU8(entry.name)
    offsets.push(offset)
    push([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(entry.method),
      ...u32(0),
      ...u32(0),
      ...u32(entry.data.length),
      ...u32(entry.size),
      ...u16(name.length),
      ...u16(0),
    ])
    push(name)
    push(entry.data)
  }
  const start = offset
  for (const index of directory) {
    const entry = entries[index]
    const name = strToU8(entry.name)
    push([
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(entry.method),
      ...u32(0),
      ...u32(0),
      ...u32(entry.data.length),
      ...u32(entry.size),
      ...u16(name.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offsets[index]),
    ])
    push(name)
  }
  push([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(directory.length),
    ...u16(directory.length),
    ...u32(offset - start),
    ...u32(start),
    ...u16(0),
  ])
  return Uint8Array.from(parts.flat())
}

export function deflated(name: string, data: Uint8Array, size = data.length): ZipEntry {
  return { name, method: 8, data: deflateSync(data), size }
}

export function zeros(name: string, bytes: number, declared = bytes): ZipEntry {
  const chunks: Uint8Array[] = []
  const deflate = new Deflate({ level: 9 }, (chunk) => chunks.push(chunk))
  const block = new Uint8Array(1024 * 1024)
  for (let left = bytes; left > 0; left -= block.length) {
    deflate.push(left > block.length ? block : block.subarray(0, left), left <= block.length)
  }
  const data = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    data.set(chunk, at)
    at += chunk.length
  }
  return { name, method: 8, data, size: declared }
}

export function entriesOf(zip: Uint8Array): ZipEntry[] {
  return Object.entries(unzipSync(zip)).map(([name, data]) => deflated(name, data))
}

export function withEntries(zip: Uint8Array, ...extra: ZipEntry[]): Uint8Array {
  return rawZip([...entriesOf(zip), ...extra])
}

function patched(zip: Uint8Array, name: string, change: (text: string) => string): ZipEntry[] {
  return entriesOf(zip).map((entry) => {
    if (entry.name !== name) return entry
    const text = new TextDecoder().decode(unzipSync(zip)[name])
    return deflated(name, strToU8(change(text)))
  })
}

export function zeroBomb(bytes: number): Uint8Array {
  return withEntries(workbook({ Data: [['safe']] }), zeros('xl/media/image1.bin', bytes))
}

export function macroWorkbook(): Uint8Array {
  const container = XLSX.CFB.utils.cfb_new()
  XLSX.CFB.utils.cfb_add(
    container,
    'VBA/Module1',
    strToU8(`Attribute VB_Name = "Module1"\nSub Auto_Open()\n${MACRO_MARKER}\nEnd Sub\n`),
  )
  const vbaraw = XLSX.CFB.write(container, { type: 'array' })
  return workbook({ Macro: [['macro book', 42]] }, 'xlsm', (book) => {
    book.vbaraw = vbaraw
  })
}

export function externalLinkWorkbook(url: string): Uint8Array {
  const base = workbook({ Links: [['open me', 7]] }, 'xlsx', (book) => {
    const sheet = book.Sheets.Links
    sheet.A1.l = { Target: `${url}/hyperlink`, Tooltip: 'link' }
  })
  const linkPart = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><externalBook r:id="rId1"><sheetNames><sheetName val="Remote"/></sheetNames><sheetDataSet><sheetData sheetId="0"><row r="1"><cell r="A1"><v>9</v></cell></row></sheetData></sheetDataSet></externalBook></externalLink>`
  const linkRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="${url}/remote.xlsx" TargetMode="External"/></Relationships>`
  const withRels = patched(base, 'xl/_rels/workbook.xml.rels', (text) =>
    text.replace(
      '</Relationships>',
      '<Relationship Id="rIdExt1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="externalLinks/externalLink1.xml"/></Relationships>',
    ),
  )
  const patchedZip = rawZip(withRels)
  const withBook = patched(patchedZip, 'xl/workbook.xml', (text) =>
    text.replace(
      '</sheets>',
      '</sheets><externalReferences><externalReference r:id="rIdExt1"/></externalReferences>',
    ),
  )
  const withTypes = patched(rawZip(withBook), '[Content_Types].xml', (text) =>
    text.replace(
      '</Types>',
      '<Override PartName="/xl/externalLinks/externalLink1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/></Types>',
    ),
  )
  return rawZip([
    ...withTypes,
    deflated('xl/externalLinks/externalLink1.xml', strToU8(linkPart)),
    deflated('xl/externalLinks/_rels/externalLink1.xml.rels', strToU8(linkRels)),
  ])
}

export function encryptedWorkbook(): Uint8Array {
  const container = XLSX.CFB.utils.cfb_new()
  XLSX.CFB.utils.cfb_add(container, 'EncryptionInfo', new Uint8Array([4, 0, 4, 0, 0x40, 0, 0, 0]))
  XLSX.CFB.utils.cfb_add(container, 'EncryptedPackage', new Uint8Array(64).fill(7))
  return new Uint8Array(XLSX.CFB.write(container, { type: 'array' }) as ArrayBuffer)
}
