import { randomUUID } from 'node:crypto'
import { arch, platform, release } from 'node:os'
import { app, ipcMain } from 'electron'
import { readEnv } from '../shared/appEnv'
import { PRODUCT_NAME } from '../shared/product'
import {
  COUNT_ID_PATTERN,
  DEFAULT_TELEMETRY_SETTINGS,
  type ErrorInput,
  type HostProperties,
  TELEMETRY_BATCH_MAX,
  TELEMETRY_COUNTS_MAX,
  TELEMETRY_INGEST_HOST,
  TELEMETRY_PROJECT_KEY,
  TELEMETRY_QUEUE_MAX,
  TELEMETRY_SEND_ATTEMPTS,
  TELEMETRY_SENT_MAX,
  TELEMETRY_URL_ENV,
  type TelemetryEndpoint,
  type TelemetryReport,
  type TelemetryReports,
  type TelemetrySettings,
  type TelemetryState,
  USAGE_COUNT_KINDS,
  type UsageCountKind,
  buildBatch,
  buildErrorReport,
  buildUsageReport,
  isUsageReport,
  parseIngest,
  parseTelemetrySettings,
} from '../shared/telemetry'
import { type LogFields, redactSecrets } from './appLog'
import { loadJson, saveJson } from './jsonStore'

export const TELEMETRY_FILE = 'telemetry.json'
export const TELEMETRY_FLUSH_DELAY_MS = 5_000
export const TELEMETRY_RETRY_DELAY_MS = 60_000
export const TELEMETRY_USAGE_INTERVAL_MS = 30 * 60 * 1000
export const TELEMETRY_REQUEST_TIMEOUT_MS = 10_000
export const TELEMETRY_QUIT_TIMEOUT_MS = 2_000

export function telemetryEndpoint(
  isPackaged: boolean,
  env: Record<string, string | undefined>,
): TelemetryEndpoint | null {
  const override = isPackaged ? undefined : readEnv(TELEMETRY_URL_ENV, env)
  return override
    ? parseIngest(override, '')
    : parseIngest(TELEMETRY_INGEST_HOST, TELEMETRY_PROJECT_KEY)
}

export function readTelemetrySettings(settings: unknown): TelemetrySettings {
  if (typeof settings !== 'object' || settings === null) return DEFAULT_TELEMETRY_SETTINGS
  const privacy = (settings as { privacy?: unknown }).privacy
  if (typeof privacy !== 'object' || privacy === null) return DEFAULT_TELEMETRY_SETTINGS
  return parseTelemetrySettings((privacy as { telemetry?: unknown }).telemetry)
}

export function telemetryClient(version: string): string {
  return `${PRODUCT_NAME}/${version}`
}

export function newInstallId(): string {
  return randomUUID()
}

export function newEventId(): string {
  return randomUUID().replace(/-/g, '')
}

interface Queued {
  report: TelemetryReport
  attempts: number
}

interface StoredTelemetry {
  installId: string
  asked: boolean
  queue: Queued[]
  sent: TelemetryReport[]
}

const INSTALL_ID_PATTERN = /^[0-9a-f-]{36}$/

function parseStored(raw: unknown): StoredTelemetry {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const installId =
    typeof value.installId === 'string' && INSTALL_ID_PATTERN.test(value.installId)
      ? value.installId
      : newInstallId()
  const queue = Array.isArray(value.queue)
    ? value.queue
        .filter(
          (q): q is Queued =>
            typeof q === 'object' &&
            q !== null &&
            typeof (q as Queued).attempts === 'number' &&
            typeof (q as Queued).report === 'object' &&
            (q as Queued).report !== null &&
            typeof (q as Queued).report.uuid === 'string',
        )
        .slice(-TELEMETRY_QUEUE_MAX)
    : []
  const sent = Array.isArray(value.sent)
    ? value.sent.filter(
        (r): r is TelemetryReport =>
          typeof r === 'object' && r !== null && typeof (r as TelemetryReport).uuid === 'string',
      )
    : []
  return { installId, asked: value.asked === true, queue, sent: sent.slice(-TELEMETRY_SENT_MAX) }
}

export type SendOutcome = 'sent' | 'failed'

export async function sendBatch(opts: {
  endpoint: TelemetryEndpoint
  body: string
  client: string
  fetchFn?: typeof fetch
  timeoutMs?: number
}): Promise<SendOutcome> {
  const fetchFn = opts.fetchFn ?? fetch
  try {
    const response = await fetchFn(opts.endpoint.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': opts.client },
      body: opts.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? TELEMETRY_REQUEST_TIMEOUT_MS),
    })
    await response.body?.cancel().catch(() => {})
    return response.status >= 200 && response.status < 300 ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}

export interface TelemetryDeps {
  file: string
  version: string
  endpoint: TelemetryEndpoint | null
  host: HostProperties
  settings: () => TelemetrySettings
  marketplaceExtensions: () => string[]
  fetchFn?: typeof fetch
  now?: () => number
  newId?: () => string
  log?: (event: string, fields?: LogFields) => void
  flushDelayMs?: number
  retryDelayMs?: number
  usageIntervalMs?: number
}

export interface Telemetry {
  error: (input: ErrorInput) => void
  count: (kind: UsageCountKind, id: string) => void
  state: () => TelemetryState
  consented: () => void
  resetInstallId: () => string
  reports: () => TelemetryReports
  settingsChanged: () => void
  flush: () => Promise<void>
  shutdown: () => Promise<void>
}

type Counts = Record<UsageCountKind, Record<string, number>>

const emptyCounts = (): Counts => ({ command: {}, surface: {}, settings: {} })

export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? newEventId
  const stored = parseStored(loadJson<unknown>(deps.file, {}))
  const startedAt = now()
  let usageSentAt = startedAt
  let counts = emptyCounts()
  let flushTimer: NodeJS.Timeout | null = null
  let retryTimer: NodeJS.Timeout | null = null
  let sending: Promise<void> | null = null
  let shutDown = false

  const save = (): void => {
    try {
      saveJson(deps.file, stored, { secure: true })
    } catch {
      deps.log?.('telemetry-unsaved')
    }
  }

  const context = () => ({
    installId: stored.installId,
    host: deps.host,
    now,
    newId,
    redact: redactSecrets,
  })

  const enqueue = (report: TelemetryReport): void => {
    stored.queue.push({ report, attempts: 0 })
    if (stored.queue.length > TELEMETRY_QUEUE_MAX) {
      stored.queue.splice(0, stored.queue.length - TELEMETRY_QUEUE_MAX)
    }
    save()
    scheduleFlush(deps.flushDelayMs ?? TELEMETRY_FLUSH_DELAY_MS)
  }

  const scheduleFlush = (delay: number): void => {
    if (!deps.endpoint || flushTimer || shutDown) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, delay)
    flushTimer.unref()
  }

  const allowed = (report: TelemetryReport, settings: TelemetrySettings): boolean =>
    isUsageReport(report) ? settings.usage : settings.errors

  const dropDisallowed = (): void => {
    const settings = deps.settings()
    const kept = stored.queue.filter((q) => allowed(q.report, settings))
    if (kept.length === stored.queue.length) return
    stored.queue = kept
    save()
  }

  const sendQueued = async (): Promise<void> => {
    const endpoint = deps.endpoint
    if (!endpoint) return
    dropDisallowed()
    const batch = stored.queue.slice(0, TELEMETRY_BATCH_MAX)
    if (batch.length === 0) return
    const outcome = await sendBatch({
      endpoint,
      body: buildBatch(
        batch.map((q) => q.report),
        endpoint.apiKey,
      ),
      client: telemetryClient(deps.version),
      fetchFn: deps.fetchFn,
    })
    const batchIds = new Set(batch.map((q) => q.report.uuid))
    if (outcome === 'sent') {
      stored.queue = stored.queue.filter((q) => !batchIds.has(q.report.uuid))
      stored.sent = [...stored.sent, ...batch.map((q) => q.report)].slice(-TELEMETRY_SENT_MAX)
      deps.log?.('telemetry-sent', { reports: batch.length })
      save()
      if (stored.queue.length > 0) scheduleFlush(0)
      return
    }
    stored.queue = stored.queue
      .map((q) => (batchIds.has(q.report.uuid) ? { ...q, attempts: q.attempts + 1 } : q))
      .filter((q) => q.attempts < TELEMETRY_SEND_ATTEMPTS)
    deps.log?.('telemetry-send-failed', { reports: batch.length })
    save()
    if (stored.queue.length > 0 && !retryTimer && !shutDown) {
      retryTimer = setTimeout(() => {
        retryTimer = null
        void flush()
      }, deps.retryDelayMs ?? TELEMETRY_RETRY_DELAY_MS)
      retryTimer.unref()
    }
  }

  const flush = (): Promise<void> => {
    sending ??= sendQueued().finally(() => {
      sending = null
    })
    return sending
  }

  const takeUsage = (): void => {
    if (!deps.settings().usage) {
      counts = emptyCounts()
      usageSentAt = now()
      return
    }
    const report = buildUsageReport(
      {
        sessionMinutes: Math.round((now() - usageSentAt) / 60_000),
        commands: counts.command,
        surfaces: counts.surface,
        settings: counts.settings,
        marketplaceExtensions: deps.marketplaceExtensions(),
      },
      context(),
    )
    counts = emptyCounts()
    usageSentAt = now()
    enqueue(report)
  }

  const usageTimer = setInterval(takeUsage, deps.usageIntervalMs ?? TELEMETRY_USAGE_INTERVAL_MS)
  usageTimer.unref()

  return {
    error: (input) => {
      if (!deps.settings().errors) return
      enqueue(buildErrorReport(input, context()))
    },
    count: (kind, id) => {
      if (!USAGE_COUNT_KINDS.includes(kind) || !COUNT_ID_PATTERN.test(id)) return
      if (!deps.settings().usage) return
      const bucket = counts[kind]
      if (!(id in bucket) && Object.keys(bucket).length >= TELEMETRY_COUNTS_MAX) return
      bucket[id] = (bucket[id] ?? 0) + 1
    },
    state: () => ({
      installId: stored.installId,
      asked: stored.asked,
      available: deps.endpoint !== null,
    }),
    consented: () => {
      stored.asked = true
      save()
    },
    resetInstallId: () => {
      stored.installId = newInstallId()
      stored.queue = []
      stored.sent = []
      counts = emptyCounts()
      save()
      return stored.installId
    },
    reports: () => ({ queued: stored.queue.map((q) => q.report), sent: [...stored.sent] }),
    settingsChanged: dropDisallowed,
    flush,
    shutdown: async () => {
      if (shutDown) return
      shutDown = true
      clearInterval(usageTimer)
      if (flushTimer) clearTimeout(flushTimer)
      if (retryTimer) clearTimeout(retryTimer)
      takeUsage()
      if (!deps.endpoint || stored.queue.length === 0) return
      await Promise.race([
        flush(),
        new Promise<void>((resolve) => setTimeout(resolve, TELEMETRY_QUIT_TIMEOUT_MS).unref()),
      ])
    },
  }
}

export function hostProperties(version: string): HostProperties {
  return {
    app_version: version,
    electron_version: process.versions.electron ?? '',
    os_name: platform(),
    os_version: release(),
    arch: arch(),
  }
}

export function registerTelemetry(deps: {
  file: string
  version: string
  readSettings: () => unknown
  marketplaceExtensions: () => string[]
  log?: (event: string, fields?: LogFields) => void
}): Telemetry {
  const telemetry = createTelemetry({
    file: deps.file,
    version: deps.version,
    endpoint: telemetryEndpoint(app.isPackaged, process.env),
    host: hostProperties(deps.version),
    settings: () => readTelemetrySettings(deps.readSettings()),
    marketplaceExtensions: deps.marketplaceExtensions,
    log: deps.log,
  })
  ipcMain.handle('telemetry:state', () => telemetry.state())
  ipcMain.handle('telemetry:consented', () => telemetry.consented())
  ipcMain.handle('telemetry:reset-id', () => telemetry.resetInstallId())
  ipcMain.handle('telemetry:reports', () => telemetry.reports())
  ipcMain.on('telemetry:count', (_e, kind: unknown, id: unknown) => {
    if (typeof kind === 'string' && typeof id === 'string') {
      telemetry.count(kind as UsageCountKind, id)
    }
  })
  return telemetry
}
