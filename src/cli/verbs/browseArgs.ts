import type { BrowseParse, Parser } from './browseFlags'
import { interactVerbs } from './browseInteractVerbs'
import { queryVerbs } from './browseQueryVerbs'
import { stateVerbs } from './browseStateVerbs'

export interface BrowseGlobals {
  json: boolean
  paneId?: string
  argv: string[]
}

export function extractGlobals(argv: string[]): BrowseGlobals | string {
  const rest: string[] = []
  let json = false
  let paneId: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') json = true
    else if (arg === '--pane') {
      paneId = argv[i + 1]
      if (!paneId) return '--pane needs a value'
      i++
    } else rest.push(arg)
  }
  return { json, paneId, argv: rest }
}

export function splitCommandLine(line: string): string[] {
  const words: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) current += line[++i]
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (ch === '\\' && i + 1 < line.length) {
      current += line[++i]
      started = true
    } else if (/\s/.test(ch)) {
      if (started) words.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (started) words.push(current)
  return words
}

const parsers: Record<string, Parser> = { ...interactVerbs, ...queryVerbs, ...stateVerbs }

export const BROWSE_VERBS = [...Object.keys(parsers), 'batch'].sort()

export function parseBrowseCommand(argv: string[], cwd: string): BrowseParse {
  const [verb, ...args] = argv
  if (!verb) return { ok: false, error: `missing command (try: ${BROWSE_VERBS.join(', ')})` }
  const parser = parsers[verb]
  if (!parser) {
    return { ok: false, error: `unknown command '${verb}' (try: ${BROWSE_VERBS.join(', ')})` }
  }
  return parser(args, cwd)
}
