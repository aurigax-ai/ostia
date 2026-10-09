export const TELEMETRY_URL_ENV = 'TELEMETRY_URL'
export const TELEMETRY_MESSAGE_MAX = 1000
const TELEMETRY_FRAMES_MAX = 50
export const TELEMETRY_QUEUE_MAX = 50
export const TELEMETRY_SENT_MAX = 20
export const TELEMETRY_BATCH_MAX = 20
export const TELEMETRY_SEND_ATTEMPTS = 3
export const TELEMETRY_COUNTS_MAX = 200
export const TELEMETRY_LIST_MAX = 100

export const TELEMETRY_CATEGORIES = [
  'errors',
  'usage',
  'features',
  'terminal',
  'extensions',
  'agents',
] as const
export type TelemetryCategory = (typeof TELEMETRY_CATEGORIES)[number]

export const USAGE_CATEGORIES = ['usage', 'features', 'terminal', 'extensions', 'agents'] as const
export type UsageCategory = (typeof USAGE_CATEGORIES)[number]

type UsageKeyKind = 'count' | 'ids' | 'value' | 'list'

export const USAGE_KEYS: Record<UsageCategory, Record<string, UsageKeyKind>> = {
  usage: {
    app_starts: 'count',
    session_minutes: 'value',
    windows: 'value',
    workspaces: 'value',
    restore: 'value',
  },
  features: {
    command: 'ids',
    surface: 'ids',
    settings: 'ids',
    chord: 'ids',
    input_mode: 'value',
    prompt_style: 'value',
  },
  terminal: {
    engine: 'value',
    gpu: 'value',
    webgl_fallback: 'count',
    wake: 'count',
    spawn_failure: 'ids',
    shell: 'ids',
  },
  extensions: {
    installed: 'list',
    enabled: 'list',
    setting_change: 'ids',
  },
  agents: {
    session: 'ids',
    resume: 'count',
    hibernation: 'count',
    approval_shown: 'ids',
    approval_answered: 'ids',
    question_asked: 'count',
    question_answered: 'count',
    bus_message: 'count',
  },
}

const ERROR_SOURCES = [
  'main-exception',
  'main-rejection',
  'renderer-gone',
  'renderer-error',
  'renderer-rejection',
  'render-error',
  'surface-error',
  'extension-crashed',
] as const
export type ErrorSource = (typeof ERROR_SOURCES)[number]

export type TelemetrySettings = Record<TelemetryCategory, boolean>

export const DEFAULT_TELEMETRY_SETTINGS: TelemetrySettings = {
  errors: false,
  usage: false,
  features: false,
  terminal: false,
  extensions: false,
  agents: false,
}

export function parseTelemetrySettings(raw: unknown): TelemetrySettings {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const out = { ...DEFAULT_TELEMETRY_SETTINGS }
  for (const category of TELEMETRY_CATEGORIES) out[category] = value[category] === true
  return out
}

export function anyTelemetryOn(settings: TelemetrySettings): boolean {
  return TELEMETRY_CATEGORIES.some((category) => settings[category])
}

export function isTelemetryCategory(value: unknown): value is TelemetryCategory {
  return typeof value === 'string' && (TELEMETRY_CATEGORIES as readonly string[]).includes(value)
}

export function isUsageCategory(value: unknown): value is UsageCategory {
  return typeof value === 'string' && (USAGE_CATEGORIES as readonly string[]).includes(value)
}

export interface TelemetryEndpoint {
  url: string
  apiKey: string
}

export function parseIngest(host: string, apiKey: string): TelemetryEndpoint | null {
  let url: URL
  try {
    url = new URL(host)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const key = apiKey || url.username
  if (key === '' || url.search !== '' || url.hash !== '') return null
  return { url: `${url.protocol}//${url.host}/batch/`, apiKey: key }
}

export interface StackFrame {
  platform: 'node'
  in_app: true
  filename?: string
  function?: string
  lineno?: number
  colno?: number
}

export interface InstallContext {
  app_version: string
  electron_version: string
  os_name: string
  os_version: string
  arch: string
  locale: string
  channel: 'packaged' | 'source'
}

interface ExceptionEntry {
  type: string
  value: string
  mechanism: { handled: boolean }
  stacktrace?: { type: 'raw'; frames: StackFrame[] }
}

interface ReportBase {
  uuid: string
  distinct_id: string
  timestamp: string
}

export interface ErrorReport extends ReportBase {
  event: '$exception'
  properties: InstallContext & {
    $process_person_profile: false
    $exception_list: [ExceptionEntry]
    source: ErrorSource
    extension?: string
  }
}

export type UsageValue = number | string | string[]

export type UsageProperties = InstallContext & { $process_person_profile: false } & {
  [key: string]: UsageValue | false
}

export interface UsageReport extends ReportBase {
  event: 'usage'
  properties: UsageProperties
}

export type TelemetryReport = ErrorReport | UsageReport

const PATH_PATTERN =
  /(?:[A-Za-z]:\\|\\\\|~[\\/]|(?<![A-Za-z0-9_:.])\/)[^\s'"`<>()[\]{},;:]*(?:[\\/][^\s'"`<>()[\]{},;:]*)*/g
const FILE_URL_PATTERN = /\b(?:file|app):\/\/[^\s'"`<>()]+/g
const QUOTED_PATH_PATTERN = /(['"`])(?:\/|~[\\/]|[A-Za-z]:\\)[^'"`\n]*\1/g

const TAB = 9
const LINE_FEED = 10
const SPACE = 32
const DELETE = 127

function isKeptChar(char: string): boolean {
  const code = char.charCodeAt(0)
  return code === TAB || code === LINE_FEED || (code >= SPACE && code !== DELETE)
}

export function stripPaths(text: string): string {
  return text
    .replace(QUOTED_PATH_PATTERN, '$1<path>$1')
    .replace(FILE_URL_PATTERN, '<path>')
    .replace(PATH_PATTERN, '<path>')
}

function clipMessage(text: string, max: number = TELEMETRY_MESSAGE_MAX): string {
  const clean = Array.from(text).filter(isKeptChar).join('')
  return clean.length > max ? clean.slice(0, max) : clean
}

const FRAME_PATTERN = /^\s*at\s+(?:(.+?)\s+\()?(.+?)(?::(\d+))?(?::(\d+))?\)?$/

function baseName(location: string): string {
  const trimmed = location.replace(/^(?:async\s+)?/, '').replace(/^[a-z]+:\/\//, '')
  const parts = trimmed.split(/[\\/]/)
  const last = parts[parts.length - 1] ?? ''
  return last.replace(/\?.*$/, '')
}

export function reduceStack(
  stack: string | undefined,
  max: number = TELEMETRY_FRAMES_MAX,
): StackFrame[] {
  if (!stack) return []
  const frames: StackFrame[] = []
  for (const line of stack.split('\n')) {
    const match = FRAME_PATTERN.exec(line)
    if (!match) continue
    const [, fn, location, lineno, colno] = match
    const frame: StackFrame = { platform: 'node', in_app: true }
    if (fn && /^[A-Za-z0-9_$.<>\[\] ]+$/.test(fn)) frame.function = fn
    const file = baseName(location)
    if (file && /^[A-Za-z0-9_.-]+$/.test(file)) frame.filename = file
    if (lineno) frame.lineno = Number(lineno)
    if (colno) frame.colno = Number(colno)
    if (Object.keys(frame).length > 2) frames.push(frame)
  }
  return frames.slice(0, max).reverse()
}

function sanitizeText(text: string, redact: (text: string) => string): string {
  return clipMessage(redact(stripPaths(text)))
}

export interface ErrorInput {
  source: ErrorSource
  name: string
  message: string
  stack?: string
  extension?: string
}

export interface ReportContext {
  installId: string
  context: InstallContext
  now: () => number
  newId: () => string
  redact: (text: string) => string
}

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,99}$/

export function buildErrorReport(input: ErrorInput, ctx: ReportContext): ErrorReport {
  const frames = reduceStack(input.stack)
  return {
    uuid: ctx.newId(),
    event: '$exception',
    distinct_id: ctx.installId,
    timestamp: new Date(ctx.now()).toISOString(),
    properties: {
      ...ctx.context,
      $process_person_profile: false,
      source: input.source,
      ...(input.extension ? { extension: input.extension } : {}),
      $exception_list: [
        {
          type: NAME_PATTERN.test(input.name) ? input.name : 'Error',
          value: sanitizeText(input.message, ctx.redact),
          mechanism: { handled: true },
          ...(frames.length > 0 ? { stacktrace: { type: 'raw', frames } } : {}),
        },
      ],
    },
  }
}

type CategoryCounts = Record<string, number | string | string[] | Record<string, number>>
export type UsageCounts = Record<UsageCategory, CategoryCounts>

export const emptyUsageCounts = (): UsageCounts => ({
  usage: {},
  features: {},
  terminal: {},
  extensions: {},
  agents: {},
})

function usageProperties(
  counts: UsageCounts,
  enabled: TelemetrySettings,
): Record<string, UsageValue> {
  const out: Record<string, UsageValue> = {}
  for (const category of USAGE_CATEGORIES) {
    if (!enabled[category]) continue
    for (const [key, value] of Object.entries(counts[category])) {
      if (typeof value === 'object' && !Array.isArray(value)) {
        for (const [id, n] of Object.entries(value)) out[`${category}.${key}.${id}`] = n
      } else {
        out[`${category}.${key}`] = value
      }
    }
  }
  return out
}

export function buildUsageReport(
  counts: UsageCounts,
  enabled: TelemetrySettings,
  ctx: ReportContext,
): UsageReport {
  return {
    uuid: ctx.newId(),
    event: 'usage',
    distinct_id: ctx.installId,
    timestamp: new Date(ctx.now()).toISOString(),
    properties: {
      ...ctx.context,
      $process_person_profile: false,
      ...usageProperties(counts, enabled),
    },
  }
}

export function isUsageReport(report: TelemetryReport): report is UsageReport {
  return report.event === 'usage'
}

export function reportCategories(report: TelemetryReport): TelemetryCategory[] {
  if (!isUsageReport(report)) return ['errors']
  const out = new Set<TelemetryCategory>()
  for (const key of Object.keys(report.properties)) {
    const prefix = key.slice(0, key.indexOf('.'))
    if (isUsageCategory(prefix)) out.add(prefix)
  }
  return TELEMETRY_CATEGORIES.filter((category) => out.has(category))
}

export function withoutCategories(
  report: UsageReport,
  disabled: TelemetrySettings,
): UsageReport | null {
  const properties: UsageProperties = { ...report.properties }
  let kept = false
  for (const key of Object.keys(properties)) {
    const prefix = key.slice(0, key.indexOf('.'))
    if (!isUsageCategory(prefix)) continue
    if (disabled[prefix]) kept = true
    else delete properties[key]
  }
  return kept ? { ...report, properties } : null
}

export function buildBatch(reports: TelemetryReport[], apiKey: string): string {
  return JSON.stringify({ api_key: apiKey, batch: reports })
}

export interface TelemetryReports {
  queued: TelemetryReport[]
  sent: TelemetryReport[]
}

export interface TelemetryState {
  installId: string
  asked: boolean
  available: boolean
  newCategories: TelemetryCategory[]
}

export const COUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
export const VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

export function bucketCount(n: number): string {
  if (n <= 0) return '0'
  if (n === 1) return '1'
  if (n <= 3) return '2-3'
  if (n <= 7) return '4-7'
  return '8+'
}

export interface TelemetryApi {
  state: () => Promise<TelemetryState>
  consented: () => Promise<void>
  categoriesSeen: () => Promise<void>
  resetInstallId: () => Promise<string>
  reports: () => Promise<TelemetryReports>
  count: (category: UsageCategory, key: string, id?: string) => void
}
