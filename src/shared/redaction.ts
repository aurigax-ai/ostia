export interface RedactionSettings {
  enabled: boolean
  patterns: string[]
}

export interface PrivacySettings {
  redaction: RedactionSettings
}

export const REDACTION_PATTERNS_MAX = 20
export const REDACTION_PATTERN_MAX = 200
export const REDACTION_REPEAT_MAX = 256
export const CUSTOM_WINDOW = 512
export const CUSTOM_WINDOW_STEP = CUSTOM_WINDOW / 2
export const CUSTOM_KIND = 'custom'

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  redaction: { enabled: true, patterns: [] },
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseRedactionSettings(raw: unknown): RedactionSettings {
  const src = isRecord(raw) ? raw : {}
  const patterns: string[] = []
  for (const item of Array.isArray(src.patterns) ? src.patterns : []) {
    if (patterns.length === REDACTION_PATTERNS_MAX) break
    if (typeof item !== 'string' || item === '' || patterns.includes(item)) continue
    patterns.push(item)
  }
  return { enabled: src.enabled !== false, patterns }
}

export function parsePrivacySettings(raw: unknown): PrivacySettings {
  return { redaction: parseRedactionSettings(isRecord(raw) ? raw.redaction : undefined) }
}

export type PatternProblem =
  | 'empty'
  | 'too-long'
  | 'invalid'
  | 'matches-empty'
  | 'lookaround'
  | 'backreference'
  | 'nested-repeat'
  | 'open-repeats'
  | 'wide-repeat'

interface GroupState {
  variable: boolean
}

interface Repeat {
  min: number
  max: number
  length: number
}

function repeatAt(source: string, at: number): Repeat | null {
  const ch = source[at]
  let repeat: Repeat | null = null
  if (ch === '*') repeat = { min: 0, max: Number.POSITIVE_INFINITY, length: 1 }
  else if (ch === '+') repeat = { min: 1, max: Number.POSITIVE_INFINITY, length: 1 }
  else if (ch === '?') repeat = { min: 0, max: 1, length: 1 }
  else if (ch === '{') {
    const braces = /^\{(\d{1,6})(?:(,)(\d{0,6}))?\}/.exec(source.slice(at, at + 16))
    if (!braces) return null
    const min = Number(braces[1])
    const max = braces[2] ? (braces[3] ? Number(braces[3]) : Number.POSITIVE_INFINITY) : min
    repeat = { min, max, length: braces[0].length }
  }
  if (!repeat) return null
  return source[at + repeat.length] === '?' ? { ...repeat, length: repeat.length + 1 } : repeat
}

function classEnd(source: string, at: number): number {
  let i = at + 1
  while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1
  return i + 1
}

function groupPrefixLength(source: string, at: number): number {
  if (source.startsWith('(?:', at)) return 3
  const named = /^\(\?<[A-Za-z_$][\w$]*>/.exec(source.slice(at, at + 64))
  return named ? named[0].length : 1
}

function structureProblem(source: string): PatternProblem | null {
  const stack: GroupState[] = [{ variable: false }]
  let closed: GroupState | null = null
  let openEnded = 0
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      const next = source[i + 1] ?? ''
      if (/[1-9k]/.test(next)) return 'backreference'
      closed = null
      i += 2
      continue
    }
    if (ch === '[') {
      closed = null
      i = classEnd(source, i)
      continue
    }
    if (ch === '(') {
      if (/^\(\?<?[=!]/.test(source.slice(i, i + 4))) return 'lookaround'
      stack.push({ variable: false })
      closed = null
      i += groupPrefixLength(source, i)
      continue
    }
    if (ch === ')') {
      const group = stack.length > 1 ? stack.pop() : undefined
      if (!group) return 'invalid'
      if (group.variable) stack[stack.length - 1].variable = true
      closed = group
      i += 1
      continue
    }
    if (ch === '|') {
      stack[stack.length - 1].variable = true
      closed = null
      i += 1
      continue
    }
    const repeat = repeatAt(source, i)
    if (repeat) {
      if (repeat.max > 1 && closed?.variable) return 'nested-repeat'
      if (repeat.max === Number.POSITIVE_INFINITY) {
        openEnded += 1
        if (openEnded > 1) return 'open-repeats'
      } else if (repeat.max > REDACTION_REPEAT_MAX) return 'wide-repeat'
      if (repeat.min !== repeat.max) stack[stack.length - 1].variable = true
      closed = null
      i += repeat.length
      continue
    }
    closed = null
    i += 1
  }
  return null
}

function compile(source: string): RegExp | null {
  try {
    return new RegExp(source, 'g')
  } catch {
    return null
  }
}

export function patternProblem(source: string): PatternProblem | null {
  if (source.trim() === '') return 'empty'
  if (source.length > REDACTION_PATTERN_MAX) return 'too-long'
  const regex = compile(source)
  if (!regex) return 'invalid'
  const structure = structureProblem(source)
  if (structure) return structure
  return regex.test('') ? 'matches-empty' : null
}

export function compilePatterns(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = []
  for (const source of patterns.slice(0, REDACTION_PATTERNS_MAX)) {
    if (patternProblem(source) !== null) continue
    const regex = compile(source)
    if (regex) out.push(regex)
  }
  return out
}

export interface SecretSpan {
  start: number
  end: number
  kind: string
}

export function customSpans(text: string, regexes: readonly RegExp[]): SecretSpan[] {
  const spans: SecretSpan[] = []
  if (regexes.length === 0) return spans
  let lineStart = 0
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    for (let at = lineStart; at < lineEnd; at += CUSTOM_WINDOW_STEP) {
      const pieceEnd = Math.min(lineEnd, at + CUSTOM_WINDOW)
      const piece = text.slice(at, pieceEnd)
      for (const regex of regexes) {
        for (const match of piece.matchAll(regex)) {
          if (match[0] === '') continue
          const start = at + match.index
          spans.push({ start, end: start + match[0].length, kind: CUSTOM_KIND })
        }
      }
      if (pieceEnd === lineEnd) break
    }
    lineStart = lineEnd + 1
  }
  return spans
}

interface ExtraDetector {
  kind: string
  pattern: RegExp
  accepts?: (value: string) => boolean
}

const NOT_A_VALUE = new Set([
  'true',
  'false',
  'null',
  'none',
  'undefined',
  'string',
  'bearer',
  'basic',
])

function looksLikeValue(value: string): boolean {
  return !NOT_A_VALUE.has(value.toLowerCase()) && !/^\d+$/.test(value)
}

const SECRET_NAME =
  '(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_-]{0,32}'

const EXTRA_DETECTORS: readonly ExtraDetector[] = [
  {
    kind: 'jwt',
    pattern:
      /(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]{8,2048}\.eyJ[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{16,1024})/g,
  },
  {
    kind: 'google-api-key',
    pattern: /(?<![A-Za-z0-9_-])(AIza[A-Za-z0-9_-]{35})(?![A-Za-z0-9_-])/g,
  },
  {
    kind: 'authorization',
    pattern:
      /authorization["']?\s{0,3}[:=]\s{0,3}["']?(?:bearer|basic|token)\s{1,3}([A-Za-z0-9._~+/=-]{8,4096})/gi,
  },
  {
    kind: 'assignment',
    pattern: new RegExp(
      `${SECRET_NAME}=([^\\s"'\`$<>(){}\\[\\],;&|\\\\\\x00-\\x1f][^\\s"'\`,;&|<>()\\x00-\\x1f]{5,255})`,
      'gi',
    ),
    accepts: looksLikeValue,
  },
  {
    kind: 'assignment',
    pattern: new RegExp(
      `${SECRET_NAME}["']?\\s{0,3}[:=]\\s{0,3}"([^"\\\\\\x00-\\x1f]{4,256})"`,
      'gi',
    ),
    accepts: looksLikeValue,
  },
  {
    kind: 'assignment',
    pattern: new RegExp(
      `${SECRET_NAME}["']?\\s{0,3}[:=]\\s{0,3}'([^'\\\\\\x00-\\x1f]{4,256})'`,
      'gi',
    ),
    accepts: looksLikeValue,
  },
]

export const EXTRA_KINDS: readonly string[] = [...new Set(EXTRA_DETECTORS.map((d) => d.kind))]

export function extraSpans(text: string): SecretSpan[] {
  const spans: SecretSpan[] = []
  for (const detector of EXTRA_DETECTORS) {
    for (const match of text.matchAll(detector.pattern)) {
      const value = match[1]
      if (!value || (detector.accepts && !detector.accepts(value))) continue
      const start = match.index + match[0].lastIndexOf(value)
      spans.push({ start, end: start + value.length, kind: detector.kind })
    }
  }
  return spans
}

const KIND_PATTERN = '[a-z0-9][a-z0-9-]{0,47}'
const PLACEHOLDER = new RegExp(`\\[redacted:${KIND_PATTERN}\\]`, 'g')

export function placeholderFor(kind: string): string {
  return `[redacted:${kind}]`
}

export function countPlaceholders(text: string): number {
  return text.match(PLACEHOLDER)?.length ?? 0
}

export interface RedactionResult {
  text: string
  count: number
  kinds: Record<string, number>
}

export function unchanged(text: string): RedactionResult {
  return { text, count: 0, kinds: {} }
}

function outsidePlaceholders(text: string, spans: readonly SecretSpan[]): SecretSpan[] {
  const holes = [...text.matchAll(PLACEHOLDER)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }))
  if (holes.length === 0) return [...spans]
  const out: SecretSpan[] = []
  for (const span of spans) {
    let start = span.start
    for (const hole of holes) {
      if (hole.end <= start) continue
      if (hole.start >= span.end) break
      if (hole.start > start) out.push({ start, end: hole.start, kind: span.kind })
      start = Math.max(start, hole.end)
    }
    if (start < span.end) out.push({ start, end: span.end, kind: span.kind })
  }
  return out
}

export function applyRedactions(text: string, found: readonly SecretSpan[]): RedactionResult {
  const spans = outsidePlaceholders(
    text,
    found.filter((s) => s.start >= 0 && s.end <= text.length && s.start < s.end),
  ).sort((a, b) => a.start - b.start || b.end - a.end)
  if (spans.length === 0) return unchanged(text)
  const merged: SecretSpan[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  const kinds: Record<string, number> = {}
  let out = ''
  let at = 0
  for (const span of merged) {
    out += text.slice(at, span.start) + placeholderFor(span.kind)
    at = span.end
    kinds[span.kind] = (kinds[span.kind] ?? 0) + 1
  }
  return { text: out + text.slice(at), count: merged.length, kinds }
}

export type RedactionKindSource = 'library' | 'ostia'

export interface RedactionKindInfo {
  kind: string
  source: RedactionKindSource
  detects: string[]
}

export const REDACT_TEXTS_MAX = 64
export const REDACT_TEXT_MAX = 2 * 1024 * 1024

export interface PrivacyApi {
  kinds: () => Promise<RedactionKindInfo[]>
  redact: (texts: string[]) => Promise<RedactionResult[]>
  preview: (text: string) => Promise<RedactionResult>
}
