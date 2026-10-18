import { isApiCompatible, parseApiVersion } from './extensionApi'
import {
  FILE_VIEWER_DISPLAY_NAME_MAX,
  type FileViewerSelector,
  matchesFilenamePattern,
  parseSelector,
} from './fileViewers'
import { isRecord } from './isRecord'

export const ARCHIVE_READERS_MAX = 8
export const ARCHIVE_READER_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
export const ARCHIVE_READERS_API = '4.13'
export const ARCHIVE_READS_DIR = 'archive-reads'
export const CORE_ARCHIVE_SUFFIXES = [
  '.zip',
  '.jar',
  '.tar',
  '.tgz',
  '.tar.gz',
  '.tzst',
  '.tar.zst',
] as const

export interface ArchiveReaderContribution {
  id: string
  displayName: string
  selector: FileViewerSelector[]
}

export interface ArchiveReaderLimits {
  entries: number
  depth: number
  nameLength: number
  scanBytes: number
  scanMs: number
  linkTargetBytes: number
}

export interface ArchiveListRequest {
  op: 'list'
  reader: string
  archive: string
  limits: ArchiveReaderLimits
}

export interface ArchiveReadRequest {
  op: 'read'
  reader: string
  archive: string
  index: number
  max: number
  out: string
  limits: ArchiveReaderLimits
}

export type ArchiveRequest = ArchiveListRequest | ArchiveReadRequest

export interface ArchiveEntryInfo {
  name: string
  index: number
  dir: boolean
  size: number
  encrypted: boolean
  link: string | null
}

export type ArchiveListResult =
  | { ok: true; entries: ArchiveEntryInfo[]; complete: boolean }
  | { ok: false; error: 'failed' | 'encrypted' | 'unsupported' }

export type ArchiveReadError =
  | 'too-large'
  | 'encrypted'
  | 'link'
  | 'gone'
  | 'unzip-limit'
  | 'failed'

export type ArchiveReadResult =
  | { ok: true; size: number }
  | { ok: false; error: ArchiveReadError; size?: number }

function suffixOf(pattern: string): string {
  return pattern.toLowerCase().startsWith('*.') ? pattern.slice(1).toLowerCase() : ''
}

export function clashesWithCore(pattern: string): boolean {
  const suffix = suffixOf(pattern)
  const name = pattern.toLowerCase()
  return CORE_ARCHIVE_SUFFIXES.some((core) =>
    suffix ? core.endsWith(suffix) || suffix.endsWith(core) : name.endsWith(core),
  )
}

export function isCoreArchiveName(name: string): boolean {
  const lower = name.toLowerCase()
  return CORE_ARCHIVE_SUFFIXES.some((core) => lower.endsWith(core))
}

export function archiveReaderMatches(
  path: string,
  reader: Pick<ArchiveReaderContribution, 'selector'>,
): boolean {
  return reader.selector.some((item) => matchesFilenamePattern(path, item.filenamePattern))
}

function parseReader(raw: unknown, where: string): ArchiveReaderContribution | string {
  if (!isRecord(raw)) return `${where}: must be an object`
  if (typeof raw.id !== 'string' || !ARCHIVE_READER_ID_PATTERN.test(raw.id)) {
    return `${where}.id must match ${ARCHIVE_READER_ID_PATTERN}`
  }
  const displayName = raw.displayName
  if (
    typeof displayName !== 'string' ||
    !displayName.trim() ||
    displayName.length > FILE_VIEWER_DISPLAY_NAME_MAX
  ) {
    return `${where}.displayName must be 1-${FILE_VIEWER_DISPLAY_NAME_MAX} characters`
  }
  const selector = parseSelector(raw.selector, where)
  if (typeof selector === 'string') return selector
  const clash = selector.find((item) => clashesWithCore(item.filenamePattern))
  if (clash) {
    return `${where}.selector: '${clash.filenamePattern}' matches an archive Files already reads`
  }
  return { id: raw.id, displayName, selector }
}

export function parseArchiveReaders(
  raw: unknown,
  api: string,
  hasMain: boolean,
): ArchiveReaderContribution[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > ARCHIVE_READERS_MAX) {
    return `contributes.archiveReaders must be an array of at most ${ARCHIVE_READERS_MAX}`
  }
  if (raw.length === 0) return []
  const wanted = parseApiVersion(ARCHIVE_READERS_API)
  const declared = parseApiVersion(api)
  if (!wanted || !declared || !isApiCompatible(wanted, declared)) {
    return `contributes.archiveReaders needs api ${ARCHIVE_READERS_API} or newer`
  }
  if (!hasMain) return 'contributes.archiveReaders needs a main process'
  const readers: ArchiveReaderContribution[] = []
  for (const [i, item] of raw.entries()) {
    const parsed = parseReader(item, `contributes.archiveReaders[${i}]`)
    if (typeof parsed === 'string') return parsed
    if (readers.some((reader) => reader.id === parsed.id)) {
      return `contributes.archiveReaders[${i}]: duplicate id '${parsed.id}'`
    }
    readers.push(parsed)
  }
  return readers
}
