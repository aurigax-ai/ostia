export const DETACH_GRACE_MS = 3000
export const RECOVERY_GRACE_MS = 10 * 60_000

export type ReapReason =
  | 'grace-expired'
  | 'exit'
  | 'closed'
  | 'restart'
  | 'hibernated'
  | 'quit'
  | 'process-kill'

export class RecoveryBook {
  private readonly until = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  start(windowId: string): void {
    this.until.set(windowId, this.now() + RECOVERY_GRACE_MS)
  }

  isRecovering(windowId: string | undefined): boolean {
    if (windowId === undefined) return false
    const until = this.until.get(windowId)
    if (until === undefined) return false
    if (until > this.now()) return true
    this.until.delete(windowId)
    return false
  }

  end(windowId: string): boolean {
    const was = this.isRecovering(windowId)
    this.until.delete(windowId)
    return was
  }

  graceFor(windowId: string | undefined): number {
    if (windowId === undefined || !this.isRecovering(windowId)) return DETACH_GRACE_MS
    return Math.max(DETACH_GRACE_MS, (this.until.get(windowId) ?? 0) - this.now())
  }
}

export interface OrphanCheck {
  current: boolean
  owners: number
  moving: boolean
  held: boolean
  recovering: boolean
}

export type OrphanVerdict = 'keep' | 'wait' | 'reap'

export function orphanVerdict(check: OrphanCheck): OrphanVerdict {
  if (!check.current || check.owners > 0 || check.moving || check.held) return 'keep'
  if (check.recovering) return 'wait'
  return 'reap'
}

export interface RecoveredPty {
  paneId: string
  owners: number
}

export function planRecovery(
  windowPtys: readonly RecoveredPty[],
  livePaneIds: ReadonlySet<string>,
): { hold: string[]; reap: string[] } {
  const hold: string[] = []
  const reap: string[] = []
  for (const { paneId, owners } of windowPtys) {
    if (!livePaneIds.has(paneId)) reap.push(paneId)
    else if (owners === 0) hold.push(paneId)
  }
  return { hold, reap }
}
