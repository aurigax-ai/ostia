import { randomUUID } from 'node:crypto'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import {
  buildBatch,
  type InstallContext,
  isTelemetryCategory,
  isUsageReport,
  TELEMETRY_BATCH_MAX,
  TELEMETRY_QUEUE_MAX,
  TELEMETRY_SEND_ATTEMPTS,
  TELEMETRY_SENT_MAX,
  type TelemetryCategory,
  type TelemetryEndpoint,
  type TelemetryReport,
  type TelemetrySettings,
  withoutCategories,
} from '../../shared/privacy/telemetry'
import { saveJson } from '../platform/jsonStore'
import type { LogFields } from './appLog'

const TELEMETRY_FLUSH_DELAY_MS = 5_000
const TELEMETRY_RETRY_DELAY_MS = 60_000
const TELEMETRY_REQUEST_TIMEOUT_MS = 10_000

function telemetryClient(version: string): string {
  return `${PRODUCT_NAME}/${version}`
}

export function newInstallId(): string {
  return randomUUID()
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

export function parseStored(raw: unknown): StoredTelemetry {
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

async function sendBatch(opts: {
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

export interface TelemetryQueueDeps {
  file: string
  endpoint: TelemetryEndpoint | null
  context: () => InstallContext
  settings: () => TelemetrySettings
  fetchFn?: typeof fetch
  log?: (event: string, fields?: LogFields) => void
  flushDelayMs?: number
  retryDelayMs?: number
}

export function createTelemetryQueue(
  deps: TelemetryQueueDeps,
  stored: StoredTelemetry,
  isShutDown: () => boolean,
) {
  let flushTimer: NodeJS.Timeout | null = null
  let retryTimer: NodeJS.Timeout | null = null
  let sending: Promise<void> | null = null

  const save = (): void => {
    try {
      saveJson(deps.file, stored, { secure: true })
    } catch {
      deps.log?.('telemetry-unsaved')
    }
  }

  const scheduleFlush = (delay: number): void => {
    if (!deps.endpoint || flushTimer || isShutDown()) return
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
    if (stored.queue.length > 0 && !retryTimer && !isShutDown()) {
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

  const clearTimers = (): void => {
    if (flushTimer) clearTimeout(flushTimer)
    if (retryTimer) clearTimeout(retryTimer)
  }

  return { save, enqueue, dropKind, flush, clearTimers }
}
