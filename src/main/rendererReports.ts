import { RENDERER_ERROR_KINDS, type RendererErrorReport } from '../shared/types'

export const REPORT_MESSAGE_MAX = 1000
export const REPORT_STACK_MAX = 8000
export const REPORT_SOURCE_MAX = 200
export const REPORT_PANE_IDS_MAX = 2000
export const REPORTS_PER_WINDOW = 20
export const REPORT_WINDOW_MS = 60_000

const TAB = 9
const LINE_FEED = 10
const SPACE = 32
const DELETE = 127

function isKeptChar(char: string): boolean {
  const code = char.charCodeAt(0)
  return code === TAB || code === LINE_FEED || (code >= SPACE && code !== DELETE)
}

function clipped(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = Array.from(value).filter(isKeptChar).join('')
  return text.length > max ? text.slice(0, max) : text
}

export function normalizeRendererReport(raw: unknown): RendererErrorReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const kind = RENDERER_ERROR_KINDS.find((k) => k === value.kind)
  const message = clipped(value.message, REPORT_MESSAGE_MAX)
  if (!kind || message === undefined) return null
  const stack = clipped(value.stack, REPORT_STACK_MAX)
  const source = clipped(value.source, REPORT_SOURCE_MAX)
  return {
    kind,
    message: message || '(no message)',
    ...(stack ? { stack } : {}),
    ...(source ? { source } : {}),
  }
}

export function normalizePaneIds(raw: unknown): Set<string> | null {
  if (!Array.isArray(raw) || raw.length > REPORT_PANE_IDS_MAX) return null
  const ids = new Set<string>()
  for (const id of raw) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) return null
    ids.add(id)
  }
  return ids
}

interface Bucket {
  start: number
  count: number
  suppressed: number
}

export class ReportLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly limit = REPORTS_PER_WINDOW,
    private readonly windowMs = REPORT_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): { allowed: boolean; suppressed: number } {
    const now = this.now()
    let bucket = this.buckets.get(key)
    let suppressed = 0
    if (!bucket || now - bucket.start >= this.windowMs) {
      suppressed = bucket?.suppressed ?? 0
      bucket = { start: now, count: 0, suppressed: 0 }
      this.buckets.set(key, bucket)
    }
    if (bucket.count >= this.limit) {
      bucket.suppressed += 1
      return { allowed: false, suppressed: 0 }
    }
    bucket.count += 1
    return { allowed: true, suppressed }
  }

  forget(key: string): void {
    this.buckets.delete(key)
  }
}
