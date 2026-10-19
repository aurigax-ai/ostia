export const GPU_CONTEXT_BUDGET = 14

export interface GpuHolder {
  readonly shown: boolean
  readonly shownAt: number
}

export function leastRecentlyShown<T extends GpuHolder>(holders: Iterable<T>): T | null {
  let oldest: T | null = null
  for (const holder of holders) {
    if (holder.shown) continue
    if (!oldest || holder.shownAt < oldest.shownAt) oldest = holder
  }
  return oldest
}

export interface GpuClaim {
  acquire(): boolean
  revoke(): void
}

export interface GpuSlot {
  show(): void
  hide(): void
  lost(): void
  dispose(): void
}

interface Member extends GpuHolder {
  shown: boolean
  shownAt: number
  holds: boolean
  waiting: boolean
  readonly claim: GpuClaim
}

export class GpuBudget {
  private readonly members = new Set<Member>()
  private clock = 0

  constructor(private readonly limit: number) {}

  join(claim: GpuClaim): GpuSlot {
    const member: Member = { shown: false, shownAt: 0, holds: false, waiting: false, claim }
    this.members.add(member)
    return {
      show: () => {
        if (!this.members.has(member)) return
        member.shown = true
        member.shownAt = ++this.clock
        if (!member.holds) this.request(member)
      },
      hide: () => {
        if (!this.members.has(member)) return
        member.shown = false
        member.waiting = false
        this.serveWaiting()
      },
      lost: () => {
        if (!this.members.has(member) || !member.holds) return
        member.holds = false
        if (member.shown) this.request(member)
        this.serveWaiting()
      },
      dispose: () => {
        if (!this.members.delete(member)) return
        if (member.holds) this.serveWaiting()
      },
    }
  }

  private request(member: Member): void {
    const holders = [...this.members].filter((m) => m.holds)
    if (holders.length >= this.limit) {
      const victim = leastRecentlyShown(holders)
      if (!victim) {
        member.waiting = true
        return
      }
      victim.holds = false
      victim.claim.revoke()
    }
    member.waiting = false
    member.holds = member.claim.acquire()
  }

  private serveWaiting(): void {
    const waiting = [...this.members].filter((m) => m.waiting).sort((a, b) => b.shownAt - a.shownAt)
    for (const member of waiting) {
      this.request(member)
      if (member.waiting) return
    }
  }
}

export const gpuBudget = new GpuBudget(GPU_CONTEXT_BUDGET)
