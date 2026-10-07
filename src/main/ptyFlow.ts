export const FLOW_HIGH_WATERMARK = 100_000
export const FLOW_LOW_WATERMARK = 5_000
export const FLOW_STALL_MS = 1_000

export interface FlowTarget {
  pause(): void
  resume(): void
}

export interface FlowLane {
  sent(chars: number): void
  close(): void
}

interface LaneState {
  unacked: number
  closed: boolean
}

export class PtyFlowControl {
  private readonly lanes = new Map<string, LaneState>()
  private paused = false
  private stallTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly target: FlowTarget) {}

  get isPaused(): boolean {
    return this.paused
  }

  open(id: string, shown: () => boolean): FlowLane {
    const state: LaneState = { unacked: 0, closed: false }
    this.lanes.set(id, state)
    this.settle()
    return {
      sent: (chars) => {
        if (state.closed) return
        if (!shown()) {
          state.unacked = 0
          return
        }
        state.unacked += chars
        if (!this.paused && state.unacked > FLOW_HIGH_WATERMARK) this.pause()
      },
      close: () => {
        state.closed = true
        if (this.lanes.get(id) !== state) return
        this.lanes.delete(id)
        this.settle()
      },
    }
  }

  ack(id: string, chars: number): void {
    const state = this.lanes.get(id)
    if (!state || !Number.isFinite(chars) || chars <= 0) return
    state.unacked = Math.max(0, state.unacked - chars)
    if (this.paused) this.armStall()
    this.settle()
  }

  hidden(id: string): void {
    const state = this.lanes.get(id)
    if (!state) return
    state.unacked = 0
    this.settle()
  }

  release(id: string): void {
    const state = this.lanes.get(id)
    if (!state) return
    state.closed = true
    this.lanes.delete(id)
    this.settle()
  }

  dispose(): void {
    this.lanes.clear()
    this.paused = false
    if (this.stallTimer) clearTimeout(this.stallTimer)
    this.stallTimer = null
  }

  private pause(): void {
    this.paused = true
    this.armStall()
    this.target.pause()
  }

  private settle(): void {
    if (!this.paused) return
    for (const state of this.lanes.values()) {
      if (state.unacked > FLOW_LOW_WATERMARK) return
    }
    this.resume()
  }

  private resume(): void {
    this.paused = false
    if (this.stallTimer) clearTimeout(this.stallTimer)
    this.stallTimer = null
    this.target.resume()
  }

  private armStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer)
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null
      for (const state of this.lanes.values()) state.unacked = 0
      this.resume()
    }, FLOW_STALL_MS)
  }
}

export class CoalescedOutput {
  private chunks: string[] = []
  private scheduled: ReturnType<typeof setImmediate> | null = null
  private closed = false

  constructor(private readonly deliver: (data: string) => void) {}

  push(data: string): void {
    if (this.closed || !data) return
    this.chunks.push(data)
    if (!this.scheduled) this.scheduled = setImmediate(() => this.flush())
  }

  flush(): void {
    if (this.scheduled) clearImmediate(this.scheduled)
    this.scheduled = null
    if (this.chunks.length === 0) return
    const data = this.chunks.length === 1 ? this.chunks[0] : this.chunks.join('')
    this.chunks = []
    this.deliver(data)
  }

  close(): void {
    this.closed = true
    if (this.scheduled) clearImmediate(this.scheduled)
    this.scheduled = null
    this.chunks = []
  }
}
