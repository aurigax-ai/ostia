import { isRecord } from './isRecord'

export const FILE_VIEWER_PRIORITIES = ['default', 'option'] as const
export type FileViewerPriority = (typeof FILE_VIEWER_PRIORITIES)[number]

export const FILE_VIEWERS_MAX = 16
export const FILE_VIEWER_SELECTORS_MAX = 32
export const FILE_VIEWER_DISPLAY_NAME_MAX = 60
export const FILE_VIEWER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
export const FILENAME_PATTERN_PATTERN =
  /^(?:\*\.[A-Za-z0-9][A-Za-z0-9._-]{0,31}|[A-Za-z0-9._-][A-Za-z0-9._ -]{0,126}[A-Za-z0-9._-]?)$/

export const VIEWER_SCHEME = 'ostia-viewer'
export const VIEWER_DOCUMENT_PATH = '/~document'
export const VIEWER_META_PATH = '/~meta'
export const VIEWER_EVENTS_PATH = '/~events'
export const VIEWER_PORTABLE_PATH = '/~portable'
export const VIEWER_CHANGED_EVENT = 'changed'

export const PORTABLE_TABLES_MAX = 256
export const PORTABLE_TABLE_ROWS_MAX = 5_000
export const PORTABLE_TABLE_COLUMNS_MAX = 1_000
export const PORTABLE_TABLES_BYTES_MAX = 16 * 1024 * 1024

export interface FileViewerSelector {
  filenamePattern: string
}

export interface FileViewerContribution {
  viewType: string
  displayName: string
  selector: FileViewerSelector[]
  priority: FileViewerPriority
  entry: string
}

export type FileViewerInfo = Omit<FileViewerContribution, 'entry'>

export interface ViewerDocumentMeta {
  name: string
  size: number
  modified: number
  locale: string
  viewType: string
}

export interface PortableTable {
  name: string
  columns: string[]
  rows: string[][]
}

export interface ViewerPortableTables {
  tables: PortableTable[]
}

function isPriority(value: unknown): value is FileViewerPriority {
  return FILE_VIEWER_PRIORITIES.includes(value as FileViewerPriority)
}

function parseSelector(raw: unknown, where: string): FileViewerSelector[] | string {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > FILE_VIEWER_SELECTORS_MAX) {
    return `${where}.selector must be an array of 1-${FILE_VIEWER_SELECTORS_MAX} entries`
  }
  const selector: FileViewerSelector[] = []
  for (const [i, item] of raw.entries()) {
    const pattern = isRecord(item) ? item.filenamePattern : undefined
    if (typeof pattern !== 'string' || !FILENAME_PATTERN_PATTERN.test(pattern)) {
      return `${where}.selector[${i}].filenamePattern must be *.<extension> or a file name`
    }
    selector.push({ filenamePattern: pattern })
  }
  return selector
}

function parseViewer(
  raw: unknown,
  where: string,
  extId: string,
  isInside: (path: string) => boolean,
): FileViewerContribution | string {
  if (!isRecord(raw)) return `${where}: must be an object`
  const viewType = raw.viewType
  const [owner, name, ...rest] = typeof viewType === 'string' ? viewType.split('.') : []
  if (owner !== extId || !name || rest.length > 0 || !FILE_VIEWER_NAME_PATTERN.test(name)) {
    return `${where}.viewType must be '${extId}.<name>' with a lowercase name`
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
  const priority = raw.priority === undefined ? 'default' : raw.priority
  if (!isPriority(priority)) {
    return `${where}.priority must be one of ${FILE_VIEWER_PRIORITIES.join(', ')}`
  }
  const entry = raw.entry
  if (typeof entry !== 'string' || !entry.endsWith('.html') || !isInside(entry)) {
    return `${where}.entry must be an .html file inside the extension`
  }
  return { viewType: viewType as string, displayName, selector, priority, entry }
}

export function parseFileViewers(
  raw: unknown,
  extId: string,
  isInside: (path: string) => boolean,
): FileViewerContribution[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > FILE_VIEWERS_MAX) {
    return `contributes.fileViewers must be an array of at most ${FILE_VIEWERS_MAX}`
  }
  const viewers: FileViewerContribution[] = []
  for (const [i, item] of raw.entries()) {
    const parsed = parseViewer(item, `contributes.fileViewers[${i}]`, extId, isInside)
    if (typeof parsed === 'string') return parsed
    if (viewers.some((viewer) => viewer.viewType === parsed.viewType)) {
      return `contributes.fileViewers[${i}]: duplicate viewType '${parsed.viewType}'`
    }
    viewers.push(parsed)
  }
  return viewers
}

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

export function matchesFilenamePattern(path: string, pattern: string): boolean {
  const name = baseName(path).toLowerCase()
  const wanted = pattern.toLowerCase()
  if (!wanted.startsWith('*.')) return name === wanted
  const suffix = wanted.slice(1)
  return name.length > suffix.length && name.endsWith(suffix)
}

export function viewerMatches(path: string, viewer: Pick<FileViewerInfo, 'selector'>): boolean {
  return viewer.selector.some((item) => matchesFilenamePattern(path, item.filenamePattern))
}
