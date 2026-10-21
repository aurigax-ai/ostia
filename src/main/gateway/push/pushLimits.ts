const PING_GAP_MS = 30_000
const PINGS_PER_HOUR = 60
const HOUR_MS = 3_600_000
const TICKETS_PER_WINDOW = 3
const TICKET_WINDOW_MS = 600_000

interface PingState {
  last: number
  recent: number[]
  blockedUntil: number
}

export class PingLimits {
  private readonly states = new Map<string, PingState>()

  constructor(private readonly now: () => number) {}

  permit(handle: string): boolean {
    const now = this.now()
    const state = this.states.get(handle) ?? { last: 0, recent: [], blockedUntil: 0 }
    const recent = state.recent.filter((at) => now - at < HOUR_MS)
    const allowed =
      now - state.last >= PING_GAP_MS && now >= state.blockedUntil && recent.length < PINGS_PER_HOUR
    this.states.set(
      handle,
      allowed ? { ...state, last: now, recent: [...recent, now] } : { ...state, recent },
    )
    return allowed
  }

  blockFor(handle: string, seconds: number): void {
    const state = this.states.get(handle)
    if (state) state.blockedUntil = this.now() + seconds * 1000
  }

  forget(handle: string): void {
    this.states.delete(handle)
  }

  clear(): void {
    this.states.clear()
  }
}

export class TicketLimits {
  private readonly asked = new Map<string, number[]>()

  constructor(private readonly now: () => number) {}

  permit(deviceId: string): boolean {
    const now = this.now()
    const recent = (this.asked.get(deviceId) ?? []).filter((at) => now - at < TICKET_WINDOW_MS)
    this.asked.set(deviceId, [...recent, now])
    return recent.length < TICKETS_PER_WINDOW
  }
}
