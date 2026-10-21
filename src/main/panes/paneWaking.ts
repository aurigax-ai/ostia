import { ChangeSignal } from '../../shared/common/actThenConfirm'

export type WakeEnd = 'started' | 'failed' | 'closed'

export type WakeWaitResult =
  | { how: 'started' }
  | { how: 'timeout' }
  | { how: 'failed' | 'closed'; paneId: string }

type WakeListener = (paneId: string, how: WakeEnd) => void

export class PaneWaking {
  private readonly panes = new Set<string>()
  private readonly listeners = new Set<WakeListener>()
  private readonly ends = new Map<string, WakeEnd>()
  private readonly reasons = new Map<string, string>()
  private readonly startedAt = new Map<string, number>()
  readonly changes = new ChangeSignal()

  lastEnd(paneId: string): WakeEnd | undefined {
    return this.panes.has(paneId) ? undefined : this.ends.get(paneId)
  }

  lastReason(paneId: string): string | undefined {
    return this.reasons.get(paneId)
  }

  has(paneId: string): boolean {
    return this.panes.has(paneId)
  }

  since(paneId: string): number | undefined {
    return this.startedAt.get(paneId)
  }

  start(paneId: string): void {
    this.panes.add(paneId)
    this.startedAt.set(paneId, Date.now())
    this.ends.delete(paneId)
    this.reasons.delete(paneId)
  }

  abandon(paneId: string): void {
    this.panes.delete(paneId)
    this.startedAt.delete(paneId)
  }

  end(paneId: string, how: WakeEnd, reason?: string): void {
    if (!this.panes.delete(paneId)) return
    this.startedAt.delete(paneId)
    this.ends.set(paneId, how)
    if (reason) this.reasons.set(paneId, reason)
    for (const listener of [...this.listeners]) listener(paneId, how)
    this.changes.fire()
  }

  subscribe(listener: WakeListener): void {
    this.listeners.add(listener)
  }

  until(
    paneIds: readonly string[],
    timeoutMs: number,
    onCancel: (cancel: () => void) => { dispose: () => void },
  ): Promise<WakeWaitResult> {
    const left = new Set(paneIds.filter((paneId) => this.panes.has(paneId)))
    if (left.size === 0) return Promise.resolve({ how: 'started' })
    return new Promise((resolve) => {
      const finish = (result: WakeWaitResult): void => {
        clearTimeout(timer)
        this.listeners.delete(listener)
        cancelled.dispose()
        resolve(result)
      }
      const listener: WakeListener = (paneId, how) => {
        if (!left.delete(paneId)) return
        if (how !== 'started') finish({ how, paneId })
        else if (left.size === 0) finish({ how: 'started' })
      }
      const timer = setTimeout(() => finish({ how: 'timeout' }), timeoutMs)
      const cancelled = onCancel(() => finish({ how: 'timeout' }))
      this.listeners.add(listener)
    })
  }
}
