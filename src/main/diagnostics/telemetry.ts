import { randomUUID } from 'node:crypto'
import { arch, platform, release } from 'node:os'
import { app, ipcMain } from 'electron'
import type { TelemetryStamp } from '../../shared/app/buildInfo'
import { readEnv } from '../../shared/appEnv'
import {
  COUNT_ID_PATTERN,
  DEFAULT_TELEMETRY_SETTINGS,
  type ErrorInput,
  type InstallContext,
  TELEMETRY_BATCH_MAX,
  TELEMETRY_CATEGORIES,
  TELEMETRY_COUNTS_MAX,
  TELEMETRY_LIST_MAX,
  TELEMETRY_QUEUE_MAX,
  TELEMETRY_SEND_ATTEMPTS,
  TELEMETRY_SENT_MAX,
  TELEMETRY_URL_ENV,
  type TelemetryCategory,
  type TelemetryEndpoint,
  type TelemetryReport,
  type TelemetryReports,
  type TelemetrySettings,
  type TelemetryState,
  USAGE_KEYS,
  type UsageCategory,
  VALUE_PATTERN,
  anyTelemetryOn,
  buildBatch,
  buildErrorReport,
  buildUsageReport,
  emptyUsageCounts,
  isTelemetryCategory,
  isUsageCategory,
  isUsageReport,
  parseIngest,
  parseTelemetrySettings,
  withoutCategories,
} from '../../shared/privacy/telemetry'
import { PRODUCT_NAME } from '../../shared/product'
import { loadJson, saveJson } from '../platform/jsonStore'
import { type LogFields, redactSecrets } from './appLog'

export const TELEMETRY_FILE = 'telemetry.json'
const TELEMETRY_FLUSH_DELAY_MS = 5_000
const TELEMETRY_RETRY_DELAY_MS = 60_000
const TELEMETRY_USAGE_INTERVAL_MS = 30 * 60 * 1000
const TELEMETRY_REQUEST_TIMEOUT_MS = 10_000
const TELEMETRY_QUIT_TIMEOUT_MS = 2_000

export function telemetryEndpoint(
  isPackaged: boolean,
  env: Record<string, string | undefined>,
  stamp: TelemetryStamp | undefined,
): TelemetryEndpoint | null {
  const override = isPackaged ? undefined : readEnv(TELEMETRY_URL_ENV, env)
  if (override) return parseIngest(override, '')
  return stamp ? parseIngest(stamp.host, stamp.key) : null
}

export function readTelemetrySettings(settings: unknown): TelemetrySettings {
  if (typeof settings !== 'object' || settings === null) return DEFAULT_TELEMETRY_SETTINGS
  const privacy = (settings as { privacy?: unknown }).privacy
  if (typeof privacy !== 'object' || privacy === null) return DEFAULT_TELEMETRY_SETTINGS
  return parseTelemetrySettings((privacy as { telemetry?: unknown }).telemetry)
}

function telemetryClient(version: string): string {
  return `${PRODUCT_NAME}/${version}`
}

function newInstallId(): string {
  return randomUUID()
}

function newEventId(): string {
  return randomUUID().replace(/-/g, '')
}

interface Queued {
  report: TelemetryReport
  attempts: number
}

interface StoredTelemetry {
  installId: string
  asked: boolean
  answeredAt: string | null
  seen: TelemetryCategory[]
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
  const seen = Array.isArray(value.seen) ? value.seen.filter(isTelemetryCategory) : []
  return {
    installId,
    asked: value.asked === true,
    answeredAt: typeof value.answeredAt === 'string' ? value.answeredAt : null,
    seen,
    queue,
    sent: sent.slice(-TELEMETRY_SENT_MAX),
  }
}

type SendOutcome = 'sent' | 'failed'

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

export interface SessionFacts {
  windows: string
  workspaces: string
  restore: string
  inEffect: Partial<Record<UsageCategory, Record<string, string>>>
  installedExtensions: string[]
  enabledExtensions: string[]
}

export interface TelemetryDeps {
  file: string
  endpoint: TelemetryEndpoint | null
  context: () => InstallContext
  settings: () => TelemetrySettings
  session: () => SessionFacts
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
  count: (category: UsageCategory, key: string, id?: string) => void
  state: () => TelemetryState
  consented: () => void
  categoriesSeen: () => void
  resetInstallId: () => string
  reports: () => TelemetryReports
  settingsChanged: () => void
  flush: () => Promise<void>
  shutdown: () => Promise<void>
}

export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? newEventId
  const stored = parseStored(loadJson<unknown>(deps.file, {}))
  const startedAt = now()
  let usageSentAt = startedAt
  let counts = emptyUsageCounts()
  let startReported = false
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

  const reportContext = () => ({
    installId: stored.installId,
    context: deps.context(),
    now,
    newId,
    redact: redactSecrets,
  })

  const scheduleFlush = (delay: number): void => {
    if (!deps.endpoint || flushTimer || shutDown) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, delay)
    flushTimer.unref()
  }

  const enqueue = (report: TelemetryReport): void => {
    stored.queue.push({ report, attempts: 0 })
    if (stored.queue.length > TELEMETRY_QUEUE_MAX) {
      stored.queue.splice(0, stored.queue.length - TELEMETRY_QUEUE_MAX)
    }
    save()
    scheduleFlush(deps.flushDelayMs ?? TELEMETRY_FLUSH_DELAY_MS)
  }

  const dropKind = (): void => {
    const settings = deps.settings()
    const kept: Queued[] = []
    for (const q of stored.queue) {
      if (!isUsageReport(q.report)) {
        if (settings.errors) kept.push(q)
        continue
      }
      const trimmed = withoutCategories(q.report, settings)
      if (trimmed) kept.push({ ...q, report: trimmed })
    }
    const changed =
      kept.length !== stored.queue.length || kept.some((q, i) => q !== stored.queue[i])
    if (!changed) return
    stored.queue = kept
    save()
  }

  const sendQueued = async (): Promise<void> => {
    const endpoint = deps.endpoint
    if (!endpoint) return
    dropKind()
    const batch = stored.queue.slice(0, TELEMETRY_BATCH_MAX)
    if (batch.length === 0) return
    const outcome = await sendBatch({
      endpoint,
      body: buildBatch(
        batch.map((q) => q.report),
        endpoint.apiKey,
      ),
      client: telemetryClient(deps.context().app_version),
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

  const setValue = (category: UsageCategory, key: string, value: string | number): void => {
    if (USAGE_KEYS[category][key] !== 'value') return
    if (typeof value === 'string' && !VALUE_PATTERN.test(value)) return
    counts[category][key] = value
  }

  const setList = (category: UsageCategory, key: string, values: string[]): void => {
    if (USAGE_KEYS[category][key] !== 'list') return
    counts[category][key] = values
      .filter((v) => COUNT_ID_PATTERN.test(v))
      .slice(0, TELEMETRY_LIST_MAX)
  }

  const sessionFacts = (settings: TelemetrySettings): void => {
    const facts = deps.session()
    if (settings.usage) {
      if (!startReported) {
        counts.usage.app_starts = 1
        startReported = true
      }
      setValue('usage', 'session_minutes', Math.round((now() - usageSentAt) / 60_000))
      setValue('usage', 'windows', facts.windows)
      setValue('usage', 'workspaces', facts.workspaces)
      setValue('usage', 'restore', facts.restore)
    }
    for (const [category, values] of Object.entries(facts.inEffect)) {
      if (!isUsageCategory(category) || !settings[category]) continue
      for (const [key, value] of Object.entries(values)) setValue(category, key, value)
    }
    if (settings.extensions) {
      setList('extensions', 'installed', facts.installedExtensions)
      setList('extensions', 'enabled', facts.enabledExtensions)
    }
  }

  const takeUsage = (): void => {
    const settings = deps.settings()
    const sendable = { ...settings, errors: false }
    if (!anyTelemetryOn(sendable)) {
      counts = emptyUsageCounts()
      usageSentAt = now()
      return
    }
    sessionFacts(settings)
    const report = buildUsageReport(counts, settings, reportContext())
    counts = emptyUsageCounts()
    usageSentAt = now()
    enqueue(report)
  }

  const usageTimer = setInterval(takeUsage, deps.usageIntervalMs ?? TELEMETRY_USAGE_INTERVAL_MS)
  usageTimer.unref()

  const newCategories = (): TelemetryCategory[] =>
    stored.asked ? TELEMETRY_CATEGORIES.filter((c) => !stored.seen.includes(c)) : []

  return {
    error: (input) => {
      if (!deps.settings().errors) return
      enqueue(buildErrorReport(input, reportContext()))
    },
    count: (category, key, id) => {
      if (!isUsageCategory(category)) return
      const kind = USAGE_KEYS[category][key]
      if (kind !== 'count' && kind !== 'ids') return
      if (!deps.settings()[category]) return
      if (kind === 'count') {
        if (id !== undefined) return
        const current = counts[category][key]
        counts[category][key] = (typeof current === 'number' ? current : 0) + 1
        return
      }
      if (typeof id !== 'string' || !COUNT_ID_PATTERN.test(id)) return
      const current = counts[category][key]
      const bucket: Record<string, number> =
        typeof current === 'object' && !Array.isArray(current) ? current : {}
      if (!(id in bucket) && Object.keys(bucket).length >= TELEMETRY_COUNTS_MAX) return
      bucket[id] = (bucket[id] ?? 0) + 1
      counts[category][key] = bucket
    },
    state: () => ({
      installId: stored.installId,
      asked: stored.asked,
      available: deps.endpoint !== null,
      newCategories: newCategories(),
    }),
    consented: () => {
      stored.asked = true
      stored.answeredAt = new Date(now()).toISOString()
      stored.seen = [...TELEMETRY_CATEGORIES]
      save()
    },
    categoriesSeen: () => {
      if (newCategories().length === 0) return
      stored.seen = [...TELEMETRY_CATEGORIES]
      save()
    },
    resetInstallId: () => {
      stored.installId = newInstallId()
      stored.queue = []
      stored.sent = []
      counts = emptyUsageCounts()
      save()
      return stored.installId
    },
    reports: () => ({ queued: stored.queue.map((q) => q.report), sent: [...stored.sent] }),
    settingsChanged: dropKind,
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

export function installContext(version: string, locale: string, packaged: boolean): InstallContext {
  return {
    app_version: version,
    electron_version: process.versions.electron ?? '',
    os_name: platform(),
    os_version: release(),
    arch: arch(),
    locale: VALUE_PATTERN.test(locale) ? locale : 'en',
    channel: packaged ? 'packaged' : 'source',
  }
}

export function registerTelemetry(deps: {
  file: string
  version: string
  stamp: TelemetryStamp | undefined
  readSettings: () => unknown
  locale: () => string | undefined
  session: () => SessionFacts
  log?: (event: string, fields?: LogFields) => void
}): Telemetry {
  const telemetry = createTelemetry({
    file: deps.file,
    endpoint: telemetryEndpoint(app.isPackaged, process.env, deps.stamp),
    context: () => installContext(deps.version, deps.locale() ?? 'en', app.isPackaged),
    settings: () => readTelemetrySettings(deps.readSettings()),
    session: deps.session,
    log: deps.log,
  })
  ipcMain.handle('telemetry:state', () => telemetry.state())
  ipcMain.handle('telemetry:consented', () => telemetry.consented())
  ipcMain.handle('telemetry:categories-seen', () => telemetry.categoriesSeen())
  ipcMain.handle('telemetry:reset-id', () => telemetry.resetInstallId())
  ipcMain.handle('telemetry:reports', () => telemetry.reports())
  ipcMain.on('telemetry:count', (_e, category: unknown, key: unknown, id: unknown) => {
    if (typeof category === 'string' && typeof key === 'string') {
      telemetry.count(category as UsageCategory, key, typeof id === 'string' ? id : undefined)
    }
  })
  return telemetry
}
