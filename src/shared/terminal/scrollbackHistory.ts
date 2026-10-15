export type ScrollbackHistory = 'off' | 'unlimited' | number

export const SCROLLBACK_HISTORY_MIN_MIB = 64
export const SCROLLBACK_HISTORY_MAX_MIB = 1_048_576
export const DEFAULT_SCROLLBACK_HISTORY: ScrollbackHistory = 'unlimited'

export function parseScrollbackHistory(raw: unknown): ScrollbackHistory {
  if (raw === 'off' || raw === 'unlimited') return raw
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SCROLLBACK_HISTORY
  return Math.min(SCROLLBACK_HISTORY_MAX_MIB, Math.max(SCROLLBACK_HISTORY_MIN_MIB, Math.round(raw)))
}

export interface HistoryPage {
  first: number
  end: number
  from: number
  lines: string[]
}

export interface HistorySearchOptions {
  caseSensitive?: boolean
  regex?: boolean
  wholeWord?: boolean
}

export interface HistoryMatch {
  line: number
  start: number
  end: number
}

export interface HistorySearchResult {
  count: number
  matches: HistoryMatch[]
}

export interface HistoryBlockRange {
  start: number
  end: number
}
