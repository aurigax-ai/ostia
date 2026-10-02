import { isDangerousSegment } from './protoGuard'
import { type RelativeStep, formatRelative } from './relativeTime'

export const VIEW_FILTERS = ['upper', 'lower', 'count', 'not', 'relative', 'time', 'date'] as const
export type ViewFilter = (typeof VIEW_FILTERS)[number]

export interface Binding {
  path: string[]
  filters: ViewFilter[]
}

export type TemplatePart = string | Binding

export interface ViewFormat {
  now: number
  locale: string
}

export type ViewScope = Readonly<Record<string, unknown>>

const SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*|\d{1,4})$/
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const BINDING = /\{\{([^{}]*)\}\}/g
const CACHE_MAX = 2000

const cache = new Map<string, TemplatePart[] | Error>()

export function isIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && !isDangerousSegment(name)
}

export function parsePath(raw: string): string[] | Error {
  const text = raw.trim()
  if (!text) return new Error('empty path')
  const segments = text.split('.')
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) return new Error(`'${text}' is not a property path`)
    if (isDangerousSegment(segment)) return new Error(`'${segment}' is not allowed in a path`)
  }
  if (!IDENTIFIER.test(segments[0])) return new Error(`'${text}' must start with a name`)
  return segments
}

function parseBinding(inner: string): Binding | Error {
  const [pathText, ...filterTexts] = inner.split('|')
  const path = parsePath(pathText)
  if (path instanceof Error) return path
  const filters: ViewFilter[] = []
  for (const raw of filterTexts) {
    const name = raw.trim()
    if (!VIEW_FILTERS.includes(name as ViewFilter)) {
      return new Error(`unknown filter '${name}' (known: ${VIEW_FILTERS.join(', ')})`)
    }
    filters.push(name as ViewFilter)
  }
  return { path, filters }
}

function compile(template: string): TemplatePart[] | Error {
  const parts: TemplatePart[] = []
  let last = 0
  for (const m of template.matchAll(BINDING)) {
    const at = m.index ?? 0
    const literal = template.slice(last, at)
    if (literal.includes('{{') || literal.includes('}}')) return new Error('unbalanced {{ }}')
    if (literal) parts.push(literal)
    const binding = parseBinding(m[1])
    if (binding instanceof Error) return binding
    parts.push(binding)
    last = at + m[0].length
  }
  const tail = template.slice(last)
  if (tail.includes('{{') || tail.includes('}}')) return new Error('unbalanced {{ }}')
  if (tail) parts.push(tail)
  return parts
}

export function compileTemplate(template: string): TemplatePart[] | Error {
  const hit = cache.get(template)
  if (hit) return hit
  const compiled = compile(template)
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(template, compiled)
  return compiled
}

export function hasBindings(template: string): boolean {
  const parts = compileTemplate(template)
  return !(parts instanceof Error) && parts.some((p) => typeof p !== 'string')
}

export function bindingsOf(template: string): Binding[] {
  const parts = compileTemplate(template)
  if (parts instanceof Error) return []
  return parts.filter((p): p is Binding => typeof p !== 'string')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function step(value: unknown, segment: string): unknown {
  if (isDangerousSegment(segment)) return undefined
  if (Array.isArray(value)) return /^\d+$/.test(segment) ? value[Number(segment)] : undefined
  if (isPlainObject(value) && Object.hasOwn(value, segment)) return value[segment]
  return undefined
}

export function lookup(scope: ViewScope, path: readonly string[]): unknown {
  let value: unknown = scope
  for (const segment of path) {
    value = step(value, segment)
    if (value === undefined) return undefined
  }
  return value
}

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0
  return Boolean(v)
}

function count(v: unknown): number {
  if (Array.isArray(v) || typeof v === 'string') return v.length
  if (isPlainObject(v)) return Object.keys(v).length
  return 0
}

const RELATIVE_STEPS: RelativeStep[] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000],
]

function relative(ms: number, fmt: ViewFormat): string {
  const format = new Intl.RelativeTimeFormat(fmt.locale, { numeric: 'auto' })
  return formatRelative(ms - fmt.now, RELATIVE_STEPS, format)
}

function applyFilter(filter: ViewFilter, v: unknown, fmt: ViewFormat): unknown {
  switch (filter) {
    case 'upper':
      return typeof v === 'string' ? v.toUpperCase() : v
    case 'lower':
      return typeof v === 'string' ? v.toLowerCase() : v
    case 'count':
      return count(v)
    case 'not':
      return !truthy(v)
    case 'relative':
      return typeof v === 'number' && Number.isFinite(v) ? relative(v, fmt) : ''
    case 'time':
      return typeof v === 'number' && Number.isFinite(v)
        ? new Intl.DateTimeFormat(fmt.locale, { hour: '2-digit', minute: '2-digit' }).format(v)
        : ''
    case 'date':
      return typeof v === 'number' && Number.isFinite(v)
        ? new Intl.DateTimeFormat(fmt.locale, { dateStyle: 'medium' }).format(v)
        : ''
  }
}

export function evalBinding(binding: Binding, scope: ViewScope, fmt: ViewFormat): unknown {
  let value = lookup(scope, binding.path)
  for (const filter of binding.filters) value = applyFilter(filter, value, fmt)
  return value
}

export function displayString(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v === 'boolean') return String(v)
  return ''
}

export function resolveValue(template: string, scope: ViewScope, fmt: ViewFormat): unknown {
  const parts = compileTemplate(template)
  if (parts instanceof Error) return ''
  if (parts.length === 1 && typeof parts[0] !== 'string') return evalBinding(parts[0], scope, fmt)
  return parts
    .map((p) => (typeof p === 'string' ? p : displayString(evalBinding(p, scope, fmt))))
    .join('')
}

export function resolveText(template: string, scope: ViewScope, fmt: ViewFormat): string {
  return displayString(resolveValue(template, scope, fmt))
}

export function resolveArgs(value: unknown, scope: ViewScope, fmt: ViewFormat): unknown {
  if (typeof value === 'string') return resolveValue(value, scope, fmt)
  if (Array.isArray(value)) return value.map((v) => resolveArgs(v, scope, fmt))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, k, {
        value: resolveArgs(v, scope, fmt),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return out
  }
  return value
}
