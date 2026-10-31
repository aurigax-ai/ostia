import type { AccountUsage } from '../../../shared/claudeAccounts/claudeAccounts'
import type { UsageToken } from './accountProfiles'
import type { UsageAnswer } from './usageApi'

export const USAGE_INTERVAL_MS = 10 * 60 * 1000
export const USAGE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000
const TICK_MS = 60 * 1000

export interface UsageTarget {
  id: string
  dir: string
}

export interface UsagePollerDeps {
  targets: () => Promise<UsageTarget[]>
  token: (dir: string) => Promise<UsageToken | null>
  stamp: (dir: string) => Promise<string | null>
  fetch: (accessToken: string) => Promise<UsageAnswer>
  onChange: () => void
  now?: () => number
  tickMs?: number
}

interface AccountPoll {
  usage: AccountUsage | null
  nextAt: number
  backoffMs: number
  rejectedStamp: string | null
}

function nextBackoff(previous: number, retryAfterMs: number | null): number {
  const wanted = retryAfterMs ?? Math.max(previous * 2, USAGE_INTERVAL_MS * 2)
  return Math.min(Math.max(wanted, USAGE_INTERVAL_MS), USAGE_BACKOFF_MAX_MS)
}

export class UsagePoller {
  private readonly polls = new Map<string, AccountPoll>()
  private readonly inFlight = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private generation = 0

  constructor(private readonly deps: UsagePollerDeps) {}

  get running(): boolean {
    return this.timer !== null
  }

  run(on: boolean): void {
    if (on === this.running) return
    this.generation++
    if (!on) {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      this.polls.clear()
      this.inFlight.clear()
      return
    }
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? TICK_MS)
    this.timer.unref?.()
    void this.tick()
  }

  usageOf(id: string): AccountUsage | null {
    return this.running ? (this.polls.get(id)?.usage ?? null) : null
  }

  async tick(): Promise<void> {
    if (!this.running) return
    const generation = this.generation
    const targets = await this.deps.targets()
    if (generation !== this.generation) return
    const wanted = new Set(targets.map((target) => target.id))
    for (const id of this.polls.keys()) if (!wanted.has(id)) this.polls.delete(id)
    await Promise.all(targets.map((target) => this.check(target, generation)))
  }

  private async check(target: UsageTarget, generation: number): Promise<void> {
    const now = this.now()
    const poll = this.polls.get(target.id) ?? {
      usage: null,
      nextAt: 0,
      backoffMs: 0,
      rejectedStamp: null,
    }
    this.polls.set(target.id, poll)
    if (this.inFlight.has(target.id) || now < poll.nextAt) return
    if (poll.rejectedStamp !== null) {
      if ((await this.deps.stamp(target.dir)) === poll.rejectedStamp) return
      poll.rejectedStamp = null
    }
    const token = await this.deps.token(target.dir)
    if (!token) {
      poll.nextAt = now + USAGE_INTERVAL_MS
      return
    }
    this.inFlight.add(target.id)
    let answer: UsageAnswer
    try {
      answer = await this.deps.fetch(token.accessToken)
    } finally {
      this.inFlight.delete(target.id)
    }
    if (generation !== this.generation || this.polls.get(target.id) !== poll) return
    this.settle(poll, answer, token.stamp, this.now())
  }

  private settle(poll: AccountPoll, answer: UsageAnswer, stamp: string, now: number): void {
    if (answer.kind === 'rate-limited') {
      poll.backoffMs = nextBackoff(poll.backoffMs, answer.retryAfterMs)
      poll.nextAt = now + poll.backoffMs
      return
    }
    poll.backoffMs = 0
    poll.nextAt = now + USAGE_INTERVAL_MS
    if (answer.kind === 'auth') poll.rejectedStamp = stamp
    if (answer.kind !== 'ok') return
    poll.usage = { session: answer.session, weekly: answer.weekly, checkedAt: now }
    this.deps.onChange()
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
