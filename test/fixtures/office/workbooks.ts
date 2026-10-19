import { deflateSync, strToU8, unzipSync } from 'fflate'
import * as XLSX from 'xlsx'

export interface ZipEntry {
  name: string
  method: 0 | 8
  data: Uint8Array
  size: number
  localSize?: number
  localExtra?: Uint8Array
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

function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((part) => (part instanceof Uint8Array ? part : Uint8Array.from(part)))
  const out = new Uint8Array(arrays.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of arrays) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function localPart(entries: ZipEntry[]): { bytes: Uint8Array; offsets: number[] } {
  const parts: (Uint8Array | number[])[] = []
  const offsets: number[] = []
  let offset = 0
  for (const entry of entries) {
    const name = strToU8(entry.name)
    const extra = entry.localExtra ?? new Uint8Array(0)
    offsets.push(offset)
    const header = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(entry.method),
      ...u32(0),
      ...u32(0),
      ...u32(entry.data.length),
      ...u32(entry.localSize ?? entry.size),
      ...u16(name.length),
      ...u16(extra.length),
    ]
    parts.push(header, name, extra, entry.data)
    offset += header.length + name.length + extra.length + entry.data.length
  }
  return { bytes: concat(parts), offsets }
}

function directoryPart(entries: ZipEntry[], offsets: number[], indices: number[]): Uint8Array {
  const parts: (Uint8Array | number[])[] = []
  for (const index of indices) {
    const entry = entries[index]
    const name = strToU8(entry.name)
    parts.push(
      [
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
      ],
      name,
    )
  }
  return concat(parts)
}

function endRecord(count: number, size: number, offset: number, comment = 0): number[] {
  return [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(count),
    ...u16(count),
    ...u32(size),
    ...u32(offset),
    ...u16(comment),
  ]
}

export function rawZip(entries: ZipEntry[], directory = entries.map((_entry, i) => i)): Uint8Array {
  const { bytes, offsets } = localPart(entries)
  const central = directoryPart(entries, offsets, directory)
  return concat([bytes, central, endRecord(directory.length, central.length, bytes.length)])
}

export function deflated(name: string, data: Uint8Array, size = data.length): ZipEntry {
  return { name, method: 8, data: deflateSync(data), size }
}

function patched(zip: Uint8Array, name: string, change: (text: string) => string): ZipEntry[] {
  return entriesOf(zip).map((entry) => {
    if (entry.name !== name) return entry
    const text = new TextDecoder().decode(unzipSync(zip)[name])
    return deflated(name, strToU8(change(text)))
  })
}

function entriesOf(zip: Uint8Array): ZipEntry[] {
  return Object.entries(unzipSync(zip)).map(([name, data]) => deflated(name, data))
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

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
  0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

export interface DocxParts {
  body: string
  relationships?: string
  doctype?: string
}

export function paragraph(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

export function picture(attribute: 'r:embed' | 'r:link', id: string, alt: string): string {
  return `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="P" descr="${alt}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip ${attribute}="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
}

export function docx({ body, relationships = '', doctype = '' }: DocxParts): Uint8Array {
  const files: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS}"><Relationship Id="rDoc" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?>${doctype}<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}</w:body></w:document>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS}"><Relationship Id="rPng" Type="${R}/image" Target="media/a.png"/>${relationships}</Relationships>`,
    'word/media/a.png': PNG,
  }
  return rawZip(
    Object.entries(files).map(([name, data]) =>
      deflated(name, typeof data === 'string' ? strToU8(data) : data),
    ),
  )
}

export function externalRelationship(id: string, type: 'hyperlink' | 'image', target: string) {
  return `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}" TargetMode="External"/>`
}
