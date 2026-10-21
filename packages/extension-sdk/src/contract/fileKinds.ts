import type { Capability } from './capabilities'
import { isRecord } from './isRecord'

export const FILE_KIND_VIEW_PRIORITIES = ['default', 'option'] as const
export type FileKindViewPriority = (typeof FILE_KIND_VIEW_PRIORITIES)[number]

export const FILE_KINDS_MAX = 16
export const FILE_KIND_SELECTORS_MAX = 32
export const FILE_KIND_PATTERNS_MAX = 64
export const FILE_KIND_DISPLAY_NAME_MAX = 60
export const FILE_KIND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
export const FILE_CONTENTS_CAPABILITY: Capability = 'file-contents'
export const FILENAME_PATTERN_PATTERN =
  /^(?:\*\.[A-Za-z0-9][A-Za-z0-9._-]{0,31}|[A-Za-z0-9._-][A-Za-z0-9._ -]{0,126}[A-Za-z0-9._-]?)$/

export const VIEWER_SCHEME = 'ostia-viewer'
export const OWN_VIEW = 'default'
export const FILE_KIND_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z][a-z0-9-]{0,39}$/
export const VIEWER_DOCUMENT_PATH = '/~document'
export const VIEWER_META_PATH = '/~meta'
export const VIEWER_EVENTS_PATH = '/~events'
export const VIEWER_PORTABLE_PATH = '/~portable'
export const VIEWER_CHANGED_EVENT = 'changed'
export const VIEWER_SELECTION_CLEARED_EVENT = 'selection-cleared'

export const PORTABLE_TABLES_MAX = 256
export const PORTABLE_TABLE_ROWS_MAX = 5_000
export const PORTABLE_TABLE_COLUMNS_MAX = 1_000
export const PORTABLE_TABLES_BYTES_MAX = 16 * 1024 * 1024

export interface FileKindSelector {
  filenamePattern: string
}

export interface FileKindView {
  entry: string
  priority: FileKindViewPriority
}

export interface FileKindContribution {
  id: string
  displayName: string
  selector: FileKindSelector[]
  view?: FileKindView
  browse?: Record<string, never>
}

export interface FileKindInfo {
  id: string
  displayName: string
  selector: FileKindSelector[]
  view?: { priority: FileKindViewPriority }
  browse?: true
  shadowed?: { name: string; patterns: string[] }[]
  approved: boolean
}

export interface FileKindParseContext {
  isInside: (path: string) => boolean
  main: boolean
  capabilities: readonly Capability[]
}

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

export function isViewType(value: string): boolean {
  return value === OWN_VIEW || FILE_KIND_ID_PATTERN.test(value)
}

function isPriority(value: unknown): value is FileKindViewPriority {
  return FILE_KIND_VIEW_PRIORITIES.includes(value as FileKindViewPriority)
}

function parseSelector(raw: unknown, where: string): FileKindSelector[] | string {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > FILE_KIND_SELECTORS_MAX) {
    return `${where}.selector must be an array of 1-${FILE_KIND_SELECTORS_MAX} entries`
  }
  const selector: FileKindSelector[] = []
  for (const [i, item] of raw.entries()) {
    const pattern = isRecord(item) ? item.filenamePattern : undefined
    if (typeof pattern !== 'string' || !FILENAME_PATTERN_PATTERN.test(pattern)) {
      return `${where}.selector[${i}].filenamePattern must be *.<extension> or a file name`
    }
    selector.push({ filenamePattern: pattern })
  }
  return selector
}

function parseView(
  raw: unknown,
  where: string,
  isInside: (path: string) => boolean,
): FileKindView | string {
  if (!isRecord(raw)) return `${where}.view must be an object`
  const priority = raw.priority === undefined ? 'default' : raw.priority
  if (!isPriority(priority)) {
    return `${where}.view.priority must be one of ${FILE_KIND_VIEW_PRIORITIES.join(', ')}`
  }
  const entry = raw.entry
  if (typeof entry !== 'string' || !entry.endsWith('.html') || !isInside(entry)) {
    return `${where}.view.entry must be an .html file inside the extension`
  }
  return { entry, priority }
}

function parseKind(
  raw: unknown,
  where: string,
  extId: string,
  context: FileKindParseContext,
): FileKindContribution | string {
  if (!isRecord(raw)) return `${where}: must be an object`
  const id = raw.id
  const [owner, name, ...rest] = typeof id === 'string' ? id.split('.') : []
  if (owner !== extId || !name || rest.length > 0 || !FILE_KIND_NAME_PATTERN.test(name)) {
    return `${where}.id must be '${extId}.<name>' with a lowercase name`
  }
  const displayName = raw.displayName
  if (
    typeof displayName !== 'string' ||
    !displayName.trim() ||
    displayName.length > FILE_KIND_DISPLAY_NAME_MAX
  ) {
    return `${where}.displayName must be 1-${FILE_KIND_DISPLAY_NAME_MAX} characters`
  }
  const selector = parseSelector(raw.selector, where)
  if (typeof selector === 'string') return selector
  if (raw.view === undefined && raw.browse === undefined) {
    return `${where} needs a view or a browse role`
  }
  const kind: FileKindContribution = { id: id as string, displayName, selector }
  if (raw.view !== undefined) {
    const view = parseView(raw.view, where, context.isInside)
    if (typeof view === 'string') return view
    kind.view = view
  }
  if (raw.browse !== undefined) {
    if (!isRecord(raw.browse)) return `${where}.browse must be an object`
    if (!context.main || !context.capabilities.includes(FILE_CONTENTS_CAPABILITY)) {
      return `${where}.browse needs a main process and the '${FILE_CONTENTS_CAPABILITY}' capability`
    }
    kind.browse = {}
  }
  return kind
}

export function parseFileKinds(
  raw: unknown,
  extId: string,
  context: FileKindParseContext,
): FileKindContribution[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > FILE_KINDS_MAX) {
    return `contributes.fileKinds must be an array of at most ${FILE_KINDS_MAX}`
  }
  const kinds: FileKindContribution[] = []
  let patterns = 0
  for (const [i, item] of raw.entries()) {
    const parsed = parseKind(item, `contributes.fileKinds[${i}]`, extId, context)
    if (typeof parsed === 'string') return parsed
    if (kinds.some((kind) => kind.id === parsed.id)) {
      return `contributes.fileKinds[${i}]: duplicate id '${parsed.id}'`
    }
    patterns += parsed.selector.length
    kinds.push(parsed)
  }
  if (patterns > FILE_KIND_PATTERNS_MAX) {
    return `contributes.fileKinds may have at most ${FILE_KIND_PATTERNS_MAX} filename patterns in all`
  }
  return kinds
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

export function kindMatches(path: string, kind: Pick<FileKindInfo, 'selector'>): boolean {
  return kind.selector.some((item) => matchesFilenamePattern(path, item.filenamePattern))
}

export type KindRoles = Pick<FileKindInfo, 'id' | 'selector' | 'view'> & { browse?: unknown }

export function kindClaim(kind: KindRoles): string {
  const patterns = kind.selector.map((item) => item.filenamePattern.toLowerCase()).sort()
  const roles = [
    ...(kind.view ? [`view:${kind.view.priority}`] : []),
    ...(kind.browse ? ['browse'] : []),
  ].join('+')
  return `${kind.id}:${roles}:${[...new Set(patterns)].join(',')}`
}

export interface BrowseCandidate {
  extId: string
  builtin: boolean
  kind: Pick<FileKindInfo, 'id' | 'selector'>
}

function longestMatch(path: string, kind: Pick<FileKindInfo, 'selector'>): number {
  let longest = -1
  for (const item of kind.selector) {
    if (matchesFilenamePattern(path, item.filenamePattern)) {
      longest = Math.max(longest, item.filenamePattern.length)
    }
  }
  return longest
}

export function browseKindFor(
  path: string,
  candidates: readonly BrowseCandidate[],
): BrowseCandidate | null {
  let best: BrowseCandidate | null = null
  let bestLength = -1
  for (const candidate of candidates) {
    const length = longestMatch(path, candidate.kind)
    if (length < 0) continue
    const better =
      best === null ||
      Number(candidate.builtin) > Number(best.builtin) ||
      (candidate.builtin === best.builtin &&
        (length > bestLength || (length === bestLength && candidate.extId < best.extId)))
    if (better) {
      best = candidate
      bestLength = length
    }
  }
  return best
}
