import {
  EVENT_BATCH_MS,
  MAIL_TURNS_MAX,
  MAIL_TURNS_WINDOW_MS,
} from '../../shared/agents/mailDelivery'

interface Mailer {
  draft: boolean
}

export class Mailers {
  private readonly ready = new Map<string, Mailer>()
  private readonly turns = new Map<string, number[]>()
  private readonly eventsTakenAt = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  set(externalId: string, draft: boolean): void {
    this.ready.set(externalId, { draft })
  }

  state(externalId: string): { draft: boolean } | undefined {
    return this.ready.get(externalId)
  }

  clear(externalId: string): void {
    this.ready.delete(externalId)
    this.turns.delete(externalId)
    this.eventsTakenAt.delete(externalId)
  }

  private recent(externalId: string): number[] {
    const since = this.now() - MAIL_TURNS_WINDOW_MS
    const kept = (this.turns.get(externalId) ?? []).filter((at) => at > since)
    this.turns.set(externalId, kept)
    return kept
  }

  limited(externalId: string): boolean {
    return this.recent(externalId).length >= MAIL_TURNS_MAX
  }

  limitedMs(externalId: string): number {
    const recent = this.recent(externalId)
    return recent.length < MAIL_TURNS_MAX
      ? 0
      : Math.max(1, recent[0] + MAIL_TURNS_WINDOW_MS - this.now())
  }

  recordTurn(externalId: string): void {
    this.recent(externalId).push(this.now())
  }

  unrecordTurn(externalId: string): void {
    this.recent(externalId).pop()
  }

  eventsWaitMs(externalId: string): number {
    const at = this.eventsTakenAt.get(externalId)
    return at === undefined ? 0 : Math.max(0, at + EVENT_BATCH_MS - this.now())
  }

  markEvents(externalId: string): void {
    this.eventsTakenAt.set(externalId, this.now())
  }
}

export const mailers = new Mailers()
