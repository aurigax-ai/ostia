export interface Grid {
  cols: number
  rows: number
}

const DEFAULT_GRID: Grid = { cols: 80, rows: 24 }

export interface OffscreenStart {
  keepSize?: boolean
}

const starters = new Map<string, (start: OffscreenStart) => void>()
const pending = new Map<string, OffscreenStart>()
let lastGrid: Grid | null = null
let held: Promise<void> | null = null

export function noteFittedGrid(cols: number, rows: number): void {
  if (cols > 0 && rows > 0) lastGrid = { cols, rows }
}

export function offscreenGrid(): Grid {
  return lastGrid ?? DEFAULT_GRID
}

function remember(paneId: string, start: OffscreenStart): void {
  const keepSize = Boolean(pending.get(paneId)?.keepSize || start.keepSize)
  pending.set(paneId, keepSize ? { ...start, keepSize } : start)
}

export function startOffscreen(paneId: string, start: OffscreenStart = {}): void {
  const starter = starters.get(paneId)
  if (starter && !held) starter(start)
  else remember(paneId, start)
}

export function holdOffscreenStarts(until: Promise<unknown>): void {
  const gate = until.then(
    () => undefined,
    () => undefined,
  )
  held = gate
  void gate.then(() => {
    if (held !== gate) return
    held = null
    for (const [paneId, start] of [...pending]) {
      const starter = starters.get(paneId)
      if (!starter) continue
      pending.delete(paneId)
      starter(start)
    }
  })
}

export function registerOffscreenStarter(
  paneId: string,
  start: (start: OffscreenStart) => void,
): () => void {
  starters.set(paneId, start)
  const asked = pending.get(paneId)
  if (asked && !held) {
    pending.delete(paneId)
    start(asked)
  }
  return () => {
    if (starters.get(paneId) === start) starters.delete(paneId)
  }
}

export function forgetOffscreenStart(paneId: string): void {
  pending.delete(paneId)
}

export function resetOffscreenStartForTests(): void {
  starters.clear()
  pending.clear()
  lastGrid = null
  held = null
}
