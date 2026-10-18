export const FOCUS_QUIET_MS = 24
export const MAX_DEFER_MS = 100
export const OVER_BUDGET_MS = 24
export const FRAME_CHARS = 131_072
export const OVER_BUDGET_HOLD_MS = 48

export interface FrameClock {
  now(): number
  frame(run: () => void): () => void
  timeout(run: () => void, ms: number): () => void
}

export const browserClock: FrameClock = {
  now: () => performance.now(),
  frame: (run) => {
    const id = requestAnimationFrame(run)
    return () => cancelAnimationFrame(id)
  },
  timeout: (run, ms) => {
    const id = setTimeout(run, ms)
    return () => clearTimeout(id)
  },
}

export interface NeighbourQueue {
  push(data: string): void
  drain(): void
  dispose(): void
}

interface Pending {
  chunks: string[]
  since: number
  write: (data: string, chunks: number) => void
}

export interface NeighbourWrites {
  noteFocusedWrite(): void
  queue(write: (data: string, chunks: number) => void): NeighbourQueue
}

export function createNeighbourWrites(clock: FrameClock = browserClock): NeighbourWrites {
  const pending = new Set<Pending>()
  let focusedAt = Number.NEGATIVE_INFINITY
  let lastFrameAt: number | null = null
  let holdUntil = Number.NEGATIVE_INFINITY
  let cancel: (() => void) | null = null

  function take(entry: Pending, budget: number): number {
    let taken = 0
    let count = 0
    while (count < entry.chunks.length && (count === 0 || taken < budget)) {
      taken += entry.chunks[count].length
      count++
    }
    const data = entry.chunks.splice(0, count).join('')
    if (entry.chunks.length === 0) pending.delete(entry)
    else entry.since = clock.now()
    entry.write(data, count)
    return taken
  }

  function run(fromFrame: boolean): void {
    cancel?.()
    cancel = null
    const now = clock.now()
    const gap = fromFrame && lastFrameAt !== null ? now - lastFrameAt : 0
    if (fromFrame) lastFrameAt = now
    if (gap > OVER_BUDGET_MS) holdUntil = now + OVER_BUDGET_HOLD_MS
    const waited = Math.max(0, ...[...pending].map((entry) => now - entry.since))
    const holding = now - focusedAt < FOCUS_QUIET_MS || now < holdUntil
    if (fromFrame && holding && waited < MAX_DEFER_MS) {
      schedule()
      return
    }
    let budget = FRAME_CHARS
    for (const entry of [...pending]) {
      if (budget <= 0) break
      budget -= take(entry, budget)
    }
    schedule()
  }

  function schedule(): void {
    if (cancel) return
    if (pending.size === 0) {
      lastFrameAt = null
      return
    }
    const cancelFrame = clock.frame(() => run(true))
    const cancelTimer = clock.timeout(() => run(false), MAX_DEFER_MS)
    cancel = () => {
      cancelFrame()
      cancelTimer()
    }
  }

  return {
    noteFocusedWrite: () => {
      focusedAt = clock.now()
    },
    queue: (write) => {
      const entry: Pending = { chunks: [], since: 0, write }
      return {
        push: (data) => {
          if (entry.chunks.length === 0) entry.since = clock.now()
          entry.chunks.push(data)
          pending.add(entry)
          schedule()
        },
        drain: () => {
          if (entry.chunks.length === 0) return
          take(entry, Number.POSITIVE_INFINITY)
        },
        dispose: () => {
          pending.delete(entry)
          entry.chunks = []
        },
      }
    },
  }
}

export const neighbourWrites = createNeighbourWrites()
