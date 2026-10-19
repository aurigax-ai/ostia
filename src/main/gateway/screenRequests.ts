import { randomUUID } from 'node:crypto'
import type {
  PhoneScreenAskOutcome,
  PhoneScreenDeclineReason,
} from '@aurigax-ai/ostia-extension-sdk/contract/phoneScreens'

const REQUEST_MS = 120_000
const DECLINE_COOLDOWN_MS = 60_000
const NO_ANSWER_COOLDOWN_MS = 15_000

export interface ScreenRequested {
  sessionId: string
  by: 'desktop' | 'agent'
  reason?: string
  agent?: 'claude' | 'codex'
  pane?: string
  requestId?: string
}

interface Waiting {
  sessionId: string
  asked: Set<string>
  declined: Map<string, PhoneScreenDeclineReason>
  resolve: (outcome: PhoneScreenAskOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

export type AskFromAgent =
  | { ok: true; answer: Promise<PhoneScreenAskOutcome> }
  | { ok: false; error: 'busy' | 'cooldown' | 'no-phone' }

export interface ScreenRequestTiming {
  waitMs: number
  cooldownMs: number
  noAnswerCooldownMs: number
}

const DEFAULT_TIMING: ScreenRequestTiming = {
  waitMs: REQUEST_MS,
  cooldownMs: DECLINE_COOLDOWN_MS,
  noAnswerCooldownMs: NO_ANSWER_COOLDOWN_MS,
}

function declineReason(declined: Map<string, PhoneScreenDeclineReason>): PhoneScreenDeclineReason {
  const reasons = [...declined.values()]
  return reasons.includes('denied') ? 'denied' : reasons.includes('off') ? 'off' : 'unsupported'
}

export class ScreenRequests {
  private readonly waiting = new Map<string, Waiting>()
  private readonly cooling = new Map<string, number>()

  constructor(
    private readonly notified: () => string[],
    private readonly send: (request: ScreenRequested, deviceIds: string[]) => void,
    private readonly now: () => number = Date.now,
    private readonly timing: ScreenRequestTiming = DEFAULT_TIMING,
  ) {}

  askFromAgent(request: Omit<ScreenRequested, 'by' | 'requestId'>): AskFromAgent {
    const now = this.now()
    for (const [sessionId, until] of this.cooling) {
      if (now >= until) this.cooling.delete(sessionId)
    }
    if (this.cooling.has(request.sessionId)) return { ok: false, error: 'cooldown' }
    const busy = new Set<string>()
    for (const open of this.waiting.values()) {
      if (open.sessionId === request.sessionId) return { ok: false, error: 'busy' }
      for (const device of open.asked) busy.add(device)
    }
    const devices = this.notified()
    const free = devices.filter((device) => !busy.has(device))
    if (devices.length === 0) return { ok: false, error: 'no-phone' }
    if (free.length === 0) return { ok: false, error: 'busy' }
    const requestId = randomUUID()
    const answer = new Promise<PhoneScreenAskOutcome>((resolve) => {
      const timer = setTimeout(() => this.unanswered(requestId), this.timing.waitMs)
      this.waiting.set(requestId, {
        sessionId: request.sessionId,
        asked: new Set(free),
        declined: new Map(),
        resolve,
        timer,
      })
    })
    this.send({ ...request, by: 'agent', requestId }, free)
    return { ok: true, answer }
  }

  decline(requestId: string, deviceId: string, reason: PhoneScreenDeclineReason): boolean {
    const open = this.waiting.get(requestId)
    if (!open?.asked.has(deviceId)) return false
    open.declined.set(deviceId, reason)
    this.settleIfAllDeclined(requestId, open)
    return true
  }

  dropDevice(deviceId: string): void {
    for (const [requestId, open] of [...this.waiting]) {
      if (!open.asked.delete(deviceId)) continue
      open.declined.delete(deviceId)
      if (open.asked.size === 0) this.unanswered(requestId)
      else this.settleIfAllDeclined(requestId, open)
    }
  }

  started(requestId: string, deviceId: string, sessionId: string): void {
    const open = this.waiting.get(requestId)
    if (!open || open.sessionId !== sessionId || !open.asked.has(deviceId)) return
    this.settle(requestId, { outcome: 'started' })
  }

  private settleIfAllDeclined(requestId: string, open: Waiting): void {
    if (open.declined.size < open.asked.size) return
    this.cooling.set(open.sessionId, this.now() + this.timing.cooldownMs)
    this.settle(requestId, { outcome: 'declined', reason: declineReason(open.declined) })
  }

  private unanswered(requestId: string): void {
    const open = this.waiting.get(requestId)
    if (!open) return
    this.cooling.set(open.sessionId, this.now() + this.timing.noAnswerCooldownMs)
    this.settle(requestId, { outcome: 'no-answer' })
  }

  private settle(requestId: string, outcome: PhoneScreenAskOutcome): boolean {
    const open = this.waiting.get(requestId)
    if (!open) return false
    this.waiting.delete(requestId)
    clearTimeout(open.timer)
    open.resolve(outcome)
    return true
  }
}
