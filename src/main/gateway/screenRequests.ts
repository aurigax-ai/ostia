import { randomUUID } from 'node:crypto'
import type {
  PhoneScreenAskOutcome,
  PhoneScreenDeclineReason,
} from '@aurigax-ai/ostia-extension-sdk/contract/phoneScreens'

const REQUEST_MS = 120_000

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
  resolve: (outcome: PhoneScreenAskOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

export class ScreenRequests {
  private readonly waiting = new Map<string, Waiting>()

  constructor(
    private readonly send: (request: ScreenRequested) => void,
    private readonly waitMs = REQUEST_MS,
  ) {}

  askFromAgent(
    request: Omit<ScreenRequested, 'by' | 'requestId'>,
  ): Promise<PhoneScreenAskOutcome> | null {
    for (const open of this.waiting.values()) {
      if (open.sessionId === request.sessionId) return null
    }
    const requestId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, { outcome: 'no-answer' }), this.waitMs)
      this.waiting.set(requestId, { sessionId: request.sessionId, resolve, timer })
      this.send({ ...request, by: 'agent', requestId })
    })
  }

  decline(requestId: string, reason: PhoneScreenDeclineReason): boolean {
    return this.settle(requestId, { outcome: 'declined', reason })
  }

  started(requestId: string): void {
    this.settle(requestId, { outcome: 'started' })
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
