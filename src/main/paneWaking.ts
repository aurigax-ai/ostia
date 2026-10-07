export type WakeEnd = 'started' | 'failed' | 'closed'

export type WakeWaitResult =
  | { how: 'started' }
  | { how: 'timeout' }
  | { how: 'failed' | 'closed'; paneId: string }

type WakeListener = (paneId: string, how: WakeEnd) => void

export class PaneWaking {
  private readonly panes = new Set<string>()
  private readonly listeners = new Set<WakeListener>()

  has(paneId: string): boolean {
    return this.panes.has(paneId)
  }

  start(paneId: string): void {
    this.panes.add(paneId)
  }

  end(paneId: string, how: WakeEnd): void {
    if (!this.panes.delete(paneId)) return
    for (const listener of [...this.listeners]) listener(paneId, how)
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
