import { zipSync } from 'fflate'
import { type ZipFile, readOfficeContainer } from './canonicalZip'
import { GuardStop, type OfficeLimits } from './officeLimits'
import { type Budget, elementCount, hyperlinkCells, odsCells, spend } from './xmlScans'

export type OfficeKind = 'sheet' | 'document'

type Format = 'ooxml' | 'ods'

const ODS_MIMETYPE = 'application/vnd.oasis.opendocument.spreadsheet'
const ODS_PARTS = new Set([
  'mimetype',
  'meta-inf/manifest.xml',
  'styles.xml',
  'content.xml',
  'meta.xml',
])
const SWITCHES_PARSER = new Set([
  'objectdata.xml',
  'index/document.iwa',
  'index.xml',
  'index.xml.gz',
])
const XML_PART = /\.(?:xml|rels)$/
const DOCUMENT_IMAGE = /^word\/media\/[^/]+\.(?:png|jpe?g|gif|webp)$/

function keyOf(name: string): string {
  return name.toLowerCase().replace(/\\/g, '/')
}

function baseName(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1)
}

function fail(): never {
  throw new GuardStop('failed')
}

function indexed(files: ZipFile[]): Map<string, ZipFile> {
  const byKey = new Map<string, ZipFile>()
  for (const file of files) {
    if (file.name.endsWith('/')) continue
    const key = keyOf(file.name)
    if (byKey.has(key) || SWITCHES_PARSER.has(key) || baseName(key) === 'index.zip') fail()
    byKey.set(key, file)
  }
  return byKey
}

function formatOf(byKey: Map<string, ZipFile>): Format {
  if (byKey.has('meta-inf/manifest.xml')) {
    const mimetype = byKey.get('mimetype')
    if (!mimetype || new TextDecoder().decode(mimetype.data) !== ODS_MIMETYPE) fail()
    return 'ods'
  }
  if (byKey.has('[content_types].xml')) return 'ooxml'
  return fail()
}

function kept(kind: OfficeKind, format: Format, key: string): boolean {
  if (format === 'ods') return ODS_PARTS.has(key)
  return XML_PART.test(key) || (kind === 'document' && DOCUMENT_IMAGE.test(key))
}

function scan(format: Format, key: string, data: Uint8Array, cells: Budget, nodes: Budget): void {
  if (!XML_PART.test(key)) return
  const text = new TextDecoder().decode(data)
  spend(nodes, elementCount(text), 'nodes-limit')
  spend(cells, format === 'ods' ? odsCells(text) : hyperlinkCells(text), 'cells-limit')
}

export function officePackage(
  bytes: Uint8Array,
  kind: OfficeKind,
  limits: OfficeLimits,
): Uint8Array {
  const byKey = indexed(readOfficeContainer(bytes, limits))
  const format = formatOf(byKey)
  if (kind === 'document' && format !== 'ooxml') fail()
  const cells: Budget = { left: limits.cells }
  const nodes: Budget = { left: kind === 'sheet' ? limits.sheetNodes : limits.documentNodes }
  const parts: Record<string, Uint8Array> = {}
  for (const [key, file] of byKey) {
    if (!kept(kind, format, key)) continue
    scan(format, key, file.data, cells, nodes)
    parts[file.name] = file.data
  }
  return zipSync(parts, { level: 0 })
}
