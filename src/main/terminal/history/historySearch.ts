import { stripVTControlCharacters } from 'node:util'
import type {
  HistoryMatch,
  HistorySearchOptions,
  HistorySearchResult,
} from '../../../shared/terminal/scrollbackHistory'
import type { PaneHistory } from './paneHistory'

const MATCH_LIMIT = 1000
const regExpWithEscape = RegExp as RegExpConstructor & { escape: (text: string) => string }

type LineMatcher = (text: string) => { start: number; end: number }[]

export function lineMatcher(query: string, opts: HistorySearchOptions): LineMatcher | null {
  if (!query) return null
  let pattern: RegExp
  try {
    const source = opts.regex ? query : regExpWithEscape.escape(query)
    const bounded = opts.wholeWord ? `\\b(?:${source})\\b` : source
    pattern = new RegExp(bounded, opts.caseSensitive ? 'g' : 'gi')
  } catch {
    return null
  }
  return (text) => {
    const hits: { start: number; end: number }[] = []
    for (const m of text.matchAll(pattern)) {
      if (m[0].length > 0) hits.push({ start: m.index, end: m.index + m[0].length })
    }
    return hits
  }
}

const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export async function searchHistory(
  history: PaneHistory,
  query: string,
  opts: HistorySearchOptions,
  until: number,
  cancelled: () => boolean,
): Promise<HistorySearchResult | null> {
  const match = lineMatcher(query, opts)
  if (!match) return { count: 0, matches: [] }
  let count = 0
  let matches: HistoryMatch[] = []
  for await (const chunk of history.chunks(history.first, until)) {
    if (cancelled()) return null
    for (let i = 0; i < chunk.lines.length; i++) {
      const line = chunk.first + i
      if (line < history.first || line >= until) continue
      for (const hit of match(stripVTControlCharacters(chunk.lines[i]))) {
        count++
        matches.push({ line, ...hit })
      }
      if (matches.length >= 2 * MATCH_LIMIT) matches = matches.slice(-MATCH_LIMIT)
    }
    await yieldTurn()
  }
  if (cancelled()) return null
  return { count, matches: matches.slice(-MATCH_LIMIT) }
}

function firstLine(command: string): string {
  return command.trim().split('\n')[0] ?? ''
}

export function sameCommand(recorded: string | null, asked: string): boolean {
  return recorded === null || !asked.trim() || firstLine(recorded) === firstLine(asked)
}

export function outputText(lines: readonly string[], endCol: number | null): string {
  const plain = lines.map((line) => stripVTControlCharacters(line))
  if (endCol !== null && plain.length > 0) {
    const last = plain.length - 1
    if (endCol > 0) plain[last] = plain[last].slice(0, endCol)
    else plain.pop()
  }
  const trimmed = plain.map((l) => l.trimEnd())
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop()
  return trimmed.join('\n')
}
