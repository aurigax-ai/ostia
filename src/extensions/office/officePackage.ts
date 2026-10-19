import { zipSync } from 'fflate'
import { type ZipFile, readOfficeContainer } from './canonicalZip'
import { GuardStop, type OfficeLimits } from './officeLimits'
import { type Budget, elementCount, hyperlinkCells, odsCells, spend } from './xmlScans'

export type OfficeKind = 'sheet' | 'document' | 'presentation'

type OfficeFormat = 'ooxml' | 'ods' | 'odt' | 'odp'

export interface OfficeParts {
  format: OfficeFormat
  parts: Map<string, ZipFile>
}

const ODF_FORMATS = new Map<string, OfficeFormat>([
  ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
  ['application/vnd.oasis.opendocument.text', 'odt'],
  ['application/vnd.oasis.opendocument.presentation', 'odp'],
])
const FORMATS: Record<OfficeKind, OfficeFormat[]> = {
  sheet: ['ooxml', 'ods'],
  document: ['ooxml', 'odt'],
  presentation: ['ooxml', 'odp'],
}
const NODES: Record<OfficeKind, 'sheetNodes' | 'documentNodes' | 'presentationNodes'> = {
  sheet: 'sheetNodes',
  document: 'documentNodes',
  presentation: 'presentationNodes',
}
const ODS_PARTS = new Set([
  'mimetype',
  'meta-inf/manifest.xml',
  'styles.xml',
  'content.xml',
  'meta.xml',
])
const ODF_OUTLINE_PARTS = new Set(['mimetype', 'meta-inf/manifest.xml', 'content.xml'])
const SWITCHES_PARSER = new Set([
  'objectdata.xml',
  'index/document.iwa',
  'index.xml',
  'index.xml.gz',
])
const XML_PART = /\.(?:xml|rels)$/
const DOCUMENT_IMAGE = /^word\/media\/[^/]+\.(?:png|jpe?g|gif|webp)$/
const PRESENTATION_PART =
  /^(?:\[content_types\]\.xml|ppt\/presentation\.xml|ppt\/_rels\/presentation\.xml\.rels|ppt\/(?:slides|notesslides)\/(?:[^/]+\.xml|_rels\/[^/]+\.xml\.rels))$/
const ODF_ENCRYPTED = /<(?:[\w.-]+:)?encryption-data[\s/>]/

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

function decoded(file: ZipFile | undefined): string {
  return file ? new TextDecoder().decode(file.data) : ''
}

function formatOf(byKey: Map<string, ZipFile>): OfficeFormat {
  const manifest = byKey.get('meta-inf/manifest.xml')
  if (manifest) {
    const format = ODF_FORMATS.get(decoded(byKey.get('mimetype'))) ?? fail()
    if (ODF_ENCRYPTED.test(decoded(manifest))) throw new GuardStop('encrypted')
    return format
  }
  if (byKey.has('[content_types].xml')) return 'ooxml'
  return fail()
}

function kept(kind: OfficeKind, format: OfficeFormat, key: string): boolean {
  if (format === 'ods') return ODS_PARTS.has(key)
  if (format !== 'ooxml') return ODF_OUTLINE_PARTS.has(key)
  if (kind === 'presentation') return PRESENTATION_PART.test(key)
  return XML_PART.test(key) || (kind === 'document' && DOCUMENT_IMAGE.test(key))
}

interface Budgets {
  cells: Budget
  nodes: Budget
}

function scan(
  kind: OfficeKind,
  format: OfficeFormat,
  key: string,
  data: Uint8Array,
  budgets: Budgets,
): void {
  if (!XML_PART.test(key)) return
  const text = new TextDecoder().decode(data)
  spend(budgets.nodes, elementCount(text), 'nodes-limit')
  if (kind !== 'sheet') return
  spend(budgets.cells, format === 'ods' ? odsCells(text) : hyperlinkCells(text), 'cells-limit')
}

export function officeParts(
  bytes: Uint8Array,
  kind: OfficeKind,
  limits: OfficeLimits,
): OfficeParts {
  const byKey = indexed(readOfficeContainer(bytes, limits))
  const format = formatOf(byKey)
  if (!FORMATS[kind].includes(format)) fail()
  const budgets = { cells: { left: limits.cells }, nodes: { left: limits[NODES[kind]] } }
  const parts = new Map<string, ZipFile>()
  for (const [key, file] of byKey) {
    if (!kept(kind, format, key)) continue
    scan(kind, format, key, file.data, budgets)
    parts.set(key, file)
  }
  return { format, parts }
}

export function zipParts(parts: Map<string, ZipFile>): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  for (const file of parts.values()) files[file.name] = file.data
  return zipSync(files, { level: 0 })
}

export function officePackage(
  bytes: Uint8Array,
  kind: OfficeKind,
  limits: OfficeLimits,
): Uint8Array {
  return zipParts(officeParts(bytes, kind, limits).parts)
}
