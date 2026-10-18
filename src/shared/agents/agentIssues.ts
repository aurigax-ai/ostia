export const MAIL_PANE_CLOSED = 'pane-closed'
export const MAIL_INBOX_FULL = 'inbox-full'
export const MAIL_LEASE_TIMEOUT = 'lease-timeout'
export const WAKE_NOT_READY = 'wake-not-ready'
export const READBACK_MISMATCH = 'readback-mismatch'
export const OVER_BUDGET = 'over-budget'
export const WAKE_BUDGET_MS = 2 * 60_000
export const STALE_MAIL_MS = 10 * 60_000

export function mailExpired(pending: string): string {
  return `expired:${pending}`
}

export const READBACK_CODES: ReadonlySet<string> = new Set([
  'not-submitted',
  'not-queued',
  'not-started',
  'not-recorded',
  'still-open',
])

export interface VerbBudget {
  ms?: number
  bytes?: number
}

export const AGENT_VERB_BUDGETS: Readonly<Record<string, VerbBudget>> = {
  'pane.list': { bytes: 24_000 },
  'pane.read': { ms: 3000, bytes: 16_000 },
  'pane.status': { ms: 3000, bytes: 6000 },
  'pane.transcript': { ms: 3000, bytes: 32_000 },
  'pane.input': { ms: 8000 },
  'pane.wait': { bytes: 2000 },
  'bus.send': { ms: 3000, bytes: 2000 },
  'bus.inbox': { bytes: 12_000 },
  'bus.sent': { bytes: 12_000 },
}

const VERB_CODE = /^([a-z][a-z-]{0,40})(?::|$)/

export function verbCode(message: string): string {
  return VERB_CODE.exec(message)?.[1] ?? 'error'
}

export function budgetBreach(
  method: string,
  ms: number,
  bytes: number,
): 'ms' | 'bytes' | undefined {
  const budget = AGENT_VERB_BUDGETS[method]
  if (budget?.ms !== undefined && ms > budget.ms) return 'ms'
  if (budget?.bytes !== undefined && bytes > budget.bytes) return 'bytes'
  return undefined
}
