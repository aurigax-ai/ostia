import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { readSessionLines, type SessionFile } from './sessionFiles'
import { clip, textOf } from './timeline'

export const FIND_LIMIT = 15
const SNIPPET_LIMIT = 120

export interface SessionScore {
  file: SessionFile
  hits: number
  words: number
  title: string
  cwd: string
  snippet: string
}

type Json = Record<string, unknown>

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function searchable(record: Json): { who: 'USER' | 'AGENT'; text: string } | null {
  const human = (v: unknown): boolean =>
    isRecord(v) && isRecord(v.origin) && v.origin.kind === 'human'
  const message = isRecord(record.message) ? record.message : {}
  if (record.type === 'user' && human(record) && typeof message.content === 'string') {
    return { who: 'USER', text: message.content }
  }
  if (record.type === 'attachment' && isRecord(record.attachment)) {
    const a = record.attachment
    if (a.type === 'queued_command' && human(a)) return { who: 'USER', text: textOf(a.prompt) }
  }
  if (record.type === 'assistant' && record.isSidechain !== true) {
    return { who: 'AGENT', text: textOf(message.content) }
  }
  return null
}

function parse(line: string): Json | null {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

export function scoreSession(
  file: SessionFile,
  terms: readonly string[],
  lines = readSessionLines(file.path),
): SessionScore {
  let hits = 0
  const matched = new Set<string>()
  let title = ''
  let cwd = ''
  let snippet = ''
  for (const line of lines) {
    const isTitle = line.includes('"type":"ai-title"')
    const low = line.toLowerCase()
    if (!isTitle && !terms.some((t) => low.includes(t))) continue
    const r = parse(line)
    if (!r) continue
    if (isTitle) title = str(r.aiTitle) || title
    cwd ||= str(r.cwd)
    const found = searchable(r)
    if (!found) continue
    const text = found.text.toLowerCase()
    const here = terms.filter((t) => text.includes(t))
    if (here.length === 0) continue
    hits++
    for (const t of here) matched.add(t)
    if (found.who === 'USER' && !snippet) snippet = clip(found.text, SNIPPET_LIMIT)
  }
  return { file, hits, words: matched.size, title, cwd, snippet }
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

export function findLines(
  files: readonly SessionFile[],
  terms: readonly string[],
  callerSession: string | null,
): string[] {
  const scores = files.map((f) => scoreSession(f, terms))
  const caller = scores.find((s) => s.file.id === callerSession)
  const ranked = scores
    .filter((s) => s.hits > 0 && s !== caller)
    .sort((a, b) => b.words - a.words || b.hits - a.hits)
  const room = FIND_LIMIT - (caller ? 1 : 0)
  const lines = [
    ...(caller ? [lineOf(caller, terms, true)] : []),
    ...ranked.slice(0, room).map((s) => lineOf(s, terms, false)),
  ]
  const more = ranked.length - room
  return more > 0 ? [...lines, `… ${more} more sessions with fewer hits`] : lines
}

function lineOf(s: SessionScore, terms: readonly string[], caller: boolean): string {
  const mark = caller ? ' (the session that handed off)' : ''
  return `${s.file.id}  ${stamp(s.file.modified)}${mark}  ${s.hits} hits, ${s.words}/${terms.length} words  ${s.cwd || s.file.project}  | ${s.title || 'untitled'} | ${s.snippet}`
}
