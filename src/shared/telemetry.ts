export const TELEMETRY_URL_ENV = 'TELEMETRY_URL'
export const TELEMETRY_MESSAGE_MAX = 1000
export const TELEMETRY_FRAMES_MAX = 50
export const TELEMETRY_QUEUE_MAX = 50
export const TELEMETRY_SENT_MAX = 20
export const TELEMETRY_BATCH_MAX = 20
export const TELEMETRY_SEND_ATTEMPTS = 3
export const TELEMETRY_COUNT_ID_MAX = 80
export const TELEMETRY_COUNTS_MAX = 200

export const USAGE_COUNT_KINDS = ['command', 'surface', 'settings'] as const
export type UsageCountKind = (typeof USAGE_COUNT_KINDS)[number]

export const ERROR_SOURCES = [
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

export interface TelemetrySettings {
  errors: boolean
  usage: boolean
}

export const DEFAULT_TELEMETRY_SETTINGS: TelemetrySettings = { errors: false, usage: false }

export function parseTelemetrySettings(raw: unknown): TelemetrySettings {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return { errors: value.errors === true, usage: value.usage === true }
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

export interface HostProperties {
  app_version: string
  electron_version: string
  os_name: string
  os_version: string
  arch: string
}

export interface ExceptionEntry {
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
  properties: HostProperties & {
    $process_person_profile: false
    $exception_list: [ExceptionEntry]
    source: ErrorSource
    extension?: string
  }
}

export interface UsageReport extends ReportBase {
  event: 'usage'
  properties: HostProperties & {
    $process_person_profile: false
    app_starts: 1
    session_minutes: number
    commands: Record<string, number>
    surfaces: Record<string, number>
    settings: Record<string, number>
    marketplace_extensions: string[]
  }
}

export type TelemetryReport = ErrorReport | UsageReport

const PATH_PATTERN =
  /(?:[A-Za-z]:\\|\\\\|~[\\/]|(?<![A-Za-z0-9_:.])\/)[^\s'"`<>()[\]{},;:]*(?:[\\/][^\s'"`<>()[\]{},;:]*)*/g
const FILE_URL_PATTERN = /\b(?:file|app):\/\/[^\s'"`<>()]+/g
const TAB = 9
const LINE_FEED = 10
const SPACE = 32
const DELETE = 127

function isKeptChar(char: string): boolean {
  const code = char.charCodeAt(0)
  return code === TAB || code === LINE_FEED || (code >= SPACE && code !== DELETE)
}

const QUOTED_PATH_PATTERN = /(['"`])(?:\/|~[\\/]|[A-Za-z]:\\)[^'"`\n]*\1/g

export function stripPaths(text: string): string {
  return text
    .replace(QUOTED_PATH_PATTERN, '$1<path>$1')
    .replace(FILE_URL_PATTERN, '<path>')
    .replace(PATH_PATTERN, '<path>')
}

export function clipMessage(text: string, max: number = TELEMETRY_MESSAGE_MAX): string {
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

export function sanitizeText(text: string, redact: (text: string) => string): string {
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
  host: HostProperties
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
      ...ctx.host,
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

export interface UsageInput {
  sessionMinutes: number
  commands: Record<string, number>
  surfaces: Record<string, number>
  settings: Record<string, number>
  marketplaceExtensions: string[]
}

export function buildUsageReport(input: UsageInput, ctx: ReportContext): UsageReport {
  return {
    uuid: ctx.newId(),
    event: 'usage',
    distinct_id: ctx.installId,
    timestamp: new Date(ctx.now()).toISOString(),
    properties: {
      ...ctx.host,
      $process_person_profile: false,
      app_starts: 1,
      session_minutes: input.sessionMinutes,
      commands: input.commands,
      surfaces: input.surfaces,
      settings: input.settings,
      marketplace_extensions: input.marketplaceExtensions,
    },
  }
}

export function isUsageReport(report: TelemetryReport): report is UsageReport {
  return report.event === 'usage'
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
}

export const COUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/

export interface TelemetryApi {
  state: () => Promise<TelemetryState>
  consented: () => Promise<void>
  resetInstallId: () => Promise<string>
  reports: () => Promise<TelemetryReports>
  count: (kind: UsageCountKind, id: string) => void
}
