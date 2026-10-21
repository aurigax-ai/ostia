import {
  anyTelemetryOn,
  buildUsageReport,
  COUNT_ID_PATTERN,
  emptyUsageCounts,
  isUsageCategory,
  TELEMETRY_COUNTS_MAX,
  TELEMETRY_LIST_MAX,
  type TelemetryReport,
  type TelemetrySettings,
  USAGE_KEYS,
  type UsageCategory,
  VALUE_PATTERN,
} from '../../shared/privacy/telemetry'

export interface SessionFacts {
  windows: string
  workspaces: string
  restore: string
  inEffect: Partial<Record<UsageCategory, Record<string, string>>>
  installedExtensions: string[]
  enabledExtensions: string[]
}

export interface TelemetryUsageDeps {
  settings: () => TelemetrySettings
  session: () => SessionFacts
}

export function createTelemetryUsage(
  deps: TelemetryUsageDeps,
  now: () => number,
  startedAt: number,
  reportContext: () => Parameters<typeof buildUsageReport>[2],
  enqueue: (report: TelemetryReport) => void,
) {
  let usageSentAt = startedAt
  let counts = emptyUsageCounts()
  let startReported = false

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

  const count = (category: UsageCategory, key: string, id?: string): void => {
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
  }

  const reset = (): void => {
    counts = emptyUsageCounts()
  }

  return { take: takeUsage, count, reset }
}
