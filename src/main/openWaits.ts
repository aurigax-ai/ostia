import type { WaitOutcome } from '../shared/openFiles'

export interface WaitRequest {
  windowId: string
  workspaceId: string
  callerPaneId: string
  paneIds: readonly string[]
}

interface Wait extends WaitRequest {
  left: Set<string>
  settle: (outcome: WaitOutcome) => void
}

export interface StartedWait {
  id: number
  done: Promise<WaitOutcome>
}

export class OpenWaits {
  private readonly waits = new Map<number, Wait>()
  private next = 1

  constructor(private readonly ended: (windowId: string, paneIds: string[]) => void = () => {}) {}

  get size(): number {
    return this.waits.size
  }

  start(request: WaitRequest): StartedWait {
    const id = this.next++
    const left = new Set(request.paneIds)
    if (left.size === 0) return { id, done: Promise.resolve('gone') }
    const done = new Promise<WaitOutcome>((settle) => {
      this.waits.set(id, { ...request, left, settle })
    })
    return { id, done }
  }

  private finish(id: number, outcome: WaitOutcome): void {
    const wait = this.waits.get(id)
    if (!wait) return
    this.waits.delete(id)
    this.ended(wait.windowId, [...wait.paneIds])
    wait.settle(outcome)
  }

  private finishWhere(matches: (wait: Wait) => boolean): void {
    for (const [id, wait] of [...this.waits]) if (matches(wait)) this.finish(id, 'gone')
  }

  paneClosed(paneId: string): void {
    for (const [id, wait] of [...this.waits]) {
      if (wait.callerPaneId === paneId) this.finish(id, 'gone')
      else if (wait.left.delete(paneId) && wait.left.size === 0) this.finish(id, 'closed')
    }
  }

  paneMoved(paneId: string): void {
    this.finishWhere((wait) => wait.left.has(paneId) || wait.callerPaneId === paneId)
  }

  callerExited(paneId: string): void {
    this.finishWhere((wait) => wait.callerPaneId === paneId)
  }

  workspaceClosed(workspaceId: string): void {
    this.finishWhere((wait) => wait.workspaceId === workspaceId)
  }

  windowGone(windowId: string): void {
    this.finishWhere((wait) => wait.windowId === windowId)
  }

  cancel(id: number): void {
    this.finish(id, 'gone')
  }
}
