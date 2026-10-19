/// <reference lib="dom" />
import type { SnapshotNode } from './browseSnapshot'

export type BrowseFail = { ok: false; error: string; message?: string }
export type BrowseOutcome<T extends object = object> = ({ ok: true } & T) | BrowseFail

export type StorageArea = 'local' | 'session'

export interface WebStorageDump {
  origin: string
  local: Record<string, string>
  session: Record<string, string>
}

export interface FindQuery {
  by: string
  value: string
  name?: string
  exact?: boolean
  index?: number
}

export type ElementState = 'visible' | 'hidden' | 'attached' | 'detached'

export interface BrowseRuntime {
  resolve: (target: string) => Element | null
  ref: (el: Element) => string
  snapshot: (scope: string | null) => BrowseOutcome<{ tree: SnapshotNode[] }>
  point: (target: string) => BrowseOutcome<{ x: number; y: number }>
  focus: (target: string) => BrowseOutcome
  fill: (target: string, text: string) => BrowseOutcome
  select: (target: string, values: string[]) => BrowseOutcome<{ values: string[] }>
  checked: (target: string) => BrowseOutcome<{ value: boolean }>
  scrollIntoView: (target: string) => BrowseOutcome
  scroll: (target: string | null, dx: number, dy: number) => BrowseOutcome
  highlight: (target: string, ms: number) => BrowseOutcome
  get: (sub: string, target: string | null, arg: string | null) => BrowseOutcome<{ value: unknown }>
  is: (sub: string, target: string) => BrowseOutcome<{ value: boolean }>
  find: (query: FindQuery) => BrowseOutcome<{ ref: string }>
  hasState: (target: string, state: ElementState) => boolean
  hasText: (text: string) => boolean
  frame: (target: string | null) => BrowseOutcome
  mark: (target: string, nonce: string) => BrowseOutcome
  unmark: (nonce: string) => void
  href: (target: string) => BrowseOutcome<{ url: string }>
  readText: () => string
  readyState: () => DocumentReadyState
  storage: () => WebStorageDump
  setStorage: (area: StorageArea, key: string, value: string) => BrowseOutcome
  removeStorage: (area: StorageArea, key: string) => BrowseOutcome
  clearStorage: (area: StorageArea) => BrowseOutcome
}

export const BROWSE_RUNTIME_GLOBAL = '__ostiaBrowse'
