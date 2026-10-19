export const BROWSE_READ_MAX = 1024 * 1024
export const BROWSE_PAGE_ENTRIES = 500
export const BROWSE_PAGE_BYTES = 256 * 1024
export const BROWSE_CACHE_BLOCKS = 8
export const BROWSE_NAME_BYTES = 4 * 1024
export const BROWSE_LISTING_BYTES = 8 * 1024 * 1024

export const BROWSE_LIST_METHOD = 'ext.browse.list'
export const BROWSE_READ_METHOD = 'ext.browse.read'
export const BROWSE_READ_AT_METHOD = 'ext.browse.readAt'
export const BROWSE_ENTRIES_METHOD = 'ext.browse.entries'
export const BROWSE_CHUNK_METHOD = 'ext.browse.chunk'

export const BROWSE_LIMITS = {
  entries: 20_000,
  depth: 32,
  nameLength: 1_024,
  scanBytes: 1024 * 1024 * 1024,
  scanMs: 20_000,
  linkTargetBytes: 1_024,
} as const

export type BrowseLimits = { readonly [K in keyof typeof BROWSE_LIMITS]: number }

export interface BrowseEntry {
  name: string
  dir: boolean
  size: number
  encrypted: boolean
  link: string | null
}

export type BrowseListError =
  | 'unsupported'
  | 'corrupt'
  | 'limit'
  | 'cancelled'
  | 'failed'
  | 'encrypted'

export type BrowseReadError =
  | 'gone'
  | 'encrypted'
  | 'link'
  | 'too-large'
  | 'limit'
  | 'corrupt'
  | 'cancelled'
  | 'failed'

export type BrowseCallError =
  | 'unknown-ticket'
  | 'over-budget'
  | 'out-of-range'
  | 'unaligned'
  | 'invalid'

export type BrowseListResult =
  | { ok: true; complete: boolean }
  | { ok: false; error: BrowseListError }

export type BrowseReadResult = { ok: true } | { ok: false; error: BrowseReadError; size?: number }

export interface BrowseListParams {
  ticket: string
  kind: string
  size: number
  limits: BrowseLimits
}

export interface BrowseReadParams extends BrowseListParams {
  index: number
  max: number
}

export interface BrowseReadAtParams {
  ticket: string
  offset: number
  length: number
}

export type BrowseReadAtResult = { ok: true; data: string } | { ok: false; error: BrowseCallError }

export interface BrowseEntriesParams {
  ticket: string
  entries: BrowseEntry[]
}

export interface BrowseChunkParams {
  ticket: string
  data: string
}

export type BrowseFlowResult = { ok: true; more: boolean } | { ok: false; error: BrowseCallError }

export function browseBlocks(size: number): number {
  return Math.ceil(size / BROWSE_READ_MAX)
}

export function browseReadBudget(size: number): number {
  return 2 * size + BROWSE_READ_MAX
}

export function browseCallBudget(size: number): number {
  return 2 * browseBlocks(size) + 64
}
