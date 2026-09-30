export interface KeeperApproval {
  ticket: string
  agent: string
  workspace: string
  intent: string
  connection: string
  tier: number
  createdAt: string
  write?: string
}

export interface KeeperDaemonStatus {
  running: boolean
  version?: string
}

export interface PollState {
  installed: boolean
  pending: number
  focused: boolean
  failures: number
}

export interface PollIntervals {
  fastMs: number
  idleMs: number
}

export const FAST_POLL_MS = 5_000
export const IDLE_POLL_MS = 60_000
export const MAX_BACKOFF_MS = 5 * 60_000
export const DEFAULT_INTERVALS: PollIntervals = { fastMs: FAST_POLL_MS, idleMs: IDLE_POLL_MS }
export const APPROVALS_PATH = '/approvals'

const ALLOWED_ARGS: readonly (readonly string[])[] = [
  ['daemon', 'status'],
  ['approve', '--json'],
  ['ui'],
]

export function isAllowedKeeperCall(args: readonly string[]): boolean {
  return ALLOWED_ARGS.some((a) => a.length === args.length && a.every((v, i) => v === args[i]))
}

export function parseDaemonStatus(stdout: string): KeeperDaemonStatus | null {
  const line = stdout.trim().split('\n')[0] ?? ''
  const running = /^running, daemon (\S+)/.exec(line)
  if (running) return { running: true, version: running[1] }
  if (/^not running\b/.test(line)) return { running: false }
  return null
}

export function parseUiUrl(stdout: string): string | null {
  const line = stdout.trim().split('\n')[0] ?? ''
  try {
    const url = new URL(line)
    if (url.protocol !== 'http:') return null
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null
    return url.origin
  } catch {
    return null
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function parseApprovals(stdout: string): KeeperApproval[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout.trim() || 'null')
  } catch {
    return null
  }
  if (raw === null) return []
  if (!Array.isArray(raw)) return null
  const out: KeeperApproval[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const it = item as Record<string, unknown>
    const ticket = str(it.ticket_id)
    if (!ticket) continue
    const session = (it.session ?? {}) as Record<string, unknown>
    const client = (session.client ?? {}) as Record<string, unknown>
    const facts = (it.facts ?? {}) as Record<string, unknown>
    const approval: KeeperApproval = {
      ticket,
      agent: str(client.name),
      workspace: str(client.workspace),
      intent: str(facts.intent) || str(session.intent),
      connection: str(it.connection),
      tier: typeof it.tier === 'number' ? it.tier : 0,
      createdAt: str(it.created_at),
    }
    const write = (it.write ?? null) as Record<string, unknown> | null
    if (write && str(write.operation)) approval.write = str(write.operation)
    out.push(approval)
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return out
}

export function nextPollDelay(
  s: PollState,
  intervals: PollIntervals = DEFAULT_INTERVALS,
): number | null {
  if (!s.installed) return null
  if (s.failures > 0) return Math.min(MAX_BACKOFF_MS, FAST_POLL_MS * 2 ** Math.min(s.failures, 10))
  if (s.pending > 0 || s.focused) return intervals.fastMs
  return intervals.idleMs
}

export function newTickets(previous: ReadonlySet<string>, current: KeeperApproval[]): string[] {
  return current.filter((a) => !previous.has(a.ticket)).map((a) => a.ticket)
}

export function ageLabel(createdAt: string, nowMs: number): string {
  const t = Date.parse(createdAt)
  if (Number.isNaN(t)) return '?'
  const s = Math.max(0, Math.round((nowMs - t) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export function formatQueue(list: KeeperApproval[], nowMs: number, empty: string): string {
  if (list.length === 0) return empty
  const rows = list.map((a) =>
    [
      a.ticket,
      a.agent || '-',
      a.workspace || '-',
      a.intent.length > 40 ? `${a.intent.slice(0, 39)}…` : a.intent || '-',
      a.connection || '-',
      a.write ? `${a.tier} ${a.write}` : `${a.tier}`,
      ageLabel(a.createdAt, nowMs),
    ].join('  '),
  )
  return ['TICKET  AGENT  WORKSPACE  INTENT  CONNECTION  TIER  AGE', ...rows].join('\n')
}
