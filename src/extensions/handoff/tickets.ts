export const TICKET_TTL_MS = 10 * 60_000
const TICKET_BIND_WAIT_MS = 5000
export const TICKETS_MAX = 8
const CLAIMED_MAX = 64

export interface HandoffTopic {
  topic: string
  agent: string
  sessionId: string
  cwd: string
  workDir: string
  workspaceId: string
}

export interface Ticket extends HandoffTopic {
  id: string
  created: number
  claimedBy: string | null
}

export type ClaimResult =
  | { ok: true; ticket: Ticket }
  | { ok: false; error: 'unknown-ticket' | 'expired-ticket' | 'claimed-ticket' | 'wrong-pane' }

interface Entry {
  ticket: Ticket
  opened: Promise<string | null>
  settle: (paneId: string | null) => void
}

export interface TicketsDeps {
  now: () => number
  newId: () => string
  waitMs?: number
}

export class Tickets {
  private readonly entries = new Map<string, Entry>()

  private readonly claimed = new Map<string, Ticket>()

  constructor(private readonly deps: TicketsDeps) {}

  create(data: HandoffTopic): Ticket {
    this.prune()
    const ticket: Ticket = {
      ...data,
      id: this.deps.newId(),
      created: this.deps.now(),
      claimedBy: null,
    }
    let settle: (paneId: string | null) => void = () => {}
    const opened = new Promise<string | null>((resolve) => {
      settle = resolve
    })
    this.entries.set(ticket.id, { ticket, opened, settle })
    return ticket
  }

  opened(id: string, paneId: string): void {
    this.entries.get(id)?.settle(paneId)
  }

  drop(id: string): void {
    this.entries.get(id)?.settle(null)
    this.entries.delete(id)
  }

  async claim(id: string, paneId: string): Promise<ClaimResult> {
    const entry = this.entries.get(id)
    if (!entry) return { ok: false, error: 'unknown-ticket' }
    if (entry.ticket.claimedBy !== null) return { ok: false, error: 'claimed-ticket' }
    if (this.deps.now() - entry.ticket.created > TICKET_TTL_MS) {
      this.entries.delete(id)
      return { ok: false, error: 'expired-ticket' }
    }
    const opened = await this.within(entry.opened)
    if (opened !== paneId) return { ok: false, error: 'wrong-pane' }
    if (entry.ticket.claimedBy !== null) return { ok: false, error: 'claimed-ticket' }
    entry.ticket.claimedBy = paneId
    if (this.claimed.size >= CLAIMED_MAX) this.forgetOldest()
    this.claimed.set(paneId, entry.ticket)
    return { ok: true, ticket: entry.ticket }
  }

  claimedBy(paneId: string): Ticket | null {
    return this.claimed.get(paneId) ?? null
  }

  forget(paneId: string): void {
    this.claimed.delete(paneId)
  }

  private forgetOldest(): void {
    const oldest = this.claimed.keys().next().value
    if (oldest !== undefined) this.claimed.delete(oldest)
  }

  private within(opened: Promise<string | null>): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), this.deps.waitMs ?? TICKET_BIND_WAIT_MS)
      timer.unref?.()
      void opened.then((paneId) => {
        clearTimeout(timer)
        resolve(paneId)
      })
    })
  }

  private prune(): void {
    const now = this.deps.now()
    for (const [id, entry] of this.entries) {
      if (now - entry.ticket.created > TICKET_TTL_MS) this.entries.delete(id)
    }
    while (this.entries.size >= TICKETS_MAX) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}
