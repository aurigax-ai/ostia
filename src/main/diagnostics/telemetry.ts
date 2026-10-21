import { randomUUID } from 'node:crypto'
import { arch, platform, release } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { app, ipcMain } from 'electron'
import type { TelemetryStamp } from '../../shared/app/buildInfo'
import {
  buildErrorReport,
  DEFAULT_TELEMETRY_SETTINGS,
  type ErrorInput,
  type InstallContext,
  parseIngest,
  parseTelemetrySettings,
  TELEMETRY_CATEGORIES,
  TELEMETRY_URL_ENV,
  type TelemetryCategory,
  type TelemetryEndpoint,
  type TelemetryReports,
  type TelemetrySettings,
  type TelemetryState,
  type UsageCategory,
  VALUE_PATTERN,
} from '../../shared/privacy/telemetry'
import { loadJson } from '../platform/jsonStore'
import { type LogFields, redactSecrets } from './appLog'
import { createTelemetryQueue, newInstallId, parseStored } from './telemetryQueue'
import { createTelemetryUsage, type SessionFacts } from './telemetryUsage'

export const TELEMETRY_FILE = 'telemetry.json'
const TELEMETRY_USAGE_INTERVAL_MS = 30 * 60 * 1000
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

function newEventId(): string {
  return randomUUID().replace(/-/g, '')
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
  let shutDown = false

  const queue = createTelemetryQueue(deps, stored, () => shutDown)

  const reportContext = () => ({
    installId: stored.installId,
    context: deps.context(),
    now,
    newId,
    redact: redactSecrets,
  })

  const usage = createTelemetryUsage(deps, now, startedAt, reportContext, queue.enqueue)

  const usageTimer = setInterval(usage.take, deps.usageIntervalMs ?? TELEMETRY_USAGE_INTERVAL_MS)
  usageTimer.unref()

  const newCategories = (): TelemetryCategory[] =>
    stored.asked ? TELEMETRY_CATEGORIES.filter((c) => !stored.seen.includes(c)) : []

  return {
    error: (input) => {
      if (!deps.settings().errors) return
      queue.enqueue(buildErrorReport(input, reportContext()))
    },
    count: usage.count,
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
      queue.save()
    },
    categoriesSeen: () => {
      if (newCategories().length === 0) return
      stored.seen = [...TELEMETRY_CATEGORIES]
      queue.save()
    },
    resetInstallId: () => {
      stored.installId = newInstallId()
      stored.queue = []
      stored.sent = []
      usage.reset()
      queue.save()
      return stored.installId
    },
    reports: () => ({ queued: stored.queue.map((q) => q.report), sent: [...stored.sent] }),
    settingsChanged: queue.dropKind,
    flush: queue.flush,
    shutdown: async () => {
      if (shutDown) return
      shutDown = true
      clearInterval(usageTimer)
      queue.clearTimers()
      usage.take()
      if (!deps.endpoint || stored.queue.length === 0) return
      await Promise.race([
        queue.flush(),
        sleep(TELEMETRY_QUIT_TIMEOUT_MS, undefined, { ref: false }),
      ])
    },
  }
}

function installContext(version: string, locale: string, packaged: boolean): InstallContext {
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
