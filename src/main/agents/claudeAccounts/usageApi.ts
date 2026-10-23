import type { UsageWindow } from '../../../shared/claudeAccounts/claudeAccounts'
import { readJson } from './signIn/anthropicOAuth'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA = 'oauth-2025-04-20'
const REQUEST_TIMEOUT_MS = 5000
const PERCENT_MAX = 999

export type UsageAnswer =
  | { kind: 'ok'; session: UsageWindow | null; weekly: UsageWindow | null }
  | { kind: 'rate-limited'; retryAfterMs: number | null }
  | { kind: 'auth' }
  | { kind: 'failed' }

function usageWindow(raw: unknown): UsageWindow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { utilization, resets_at } = raw as Record<string, unknown>
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null
  const resetsAt = typeof resets_at === 'string' ? Date.parse(resets_at) : Number.NaN
  if (!Number.isFinite(resetsAt)) return null
  return { percent: Math.min(Math.max(utilization, 0), PERCENT_MAX), resetsAt }
}

export function parseUsage(body: Record<string, unknown> | null): UsageAnswer {
  if (!body || !('five_hour' in body || 'seven_day' in body)) return { kind: 'failed' }
  return { kind: 'ok', session: usageWindow(body.five_hour), weekly: usageWindow(body.seven_day) }
}

function retryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

export async function fetchUsage(
  accessToken: string,
  request: typeof fetch = fetch,
): Promise<UsageAnswer> {
  const res = await request(USAGE_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      'anthropic-beta': OAUTH_BETA,
      'content-type': 'application/json',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => null)
  if (!res) return { kind: 'failed' }
  if (res.status === 429) {
    await res.body?.cancel().catch(() => undefined)
    return { kind: 'rate-limited', retryAfterMs: retryAfter(res.headers.get('retry-after')) }
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined)
    return { kind: 'auth' }
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    return { kind: 'failed' }
  }
  return parseUsage(await readJson(res))
}
