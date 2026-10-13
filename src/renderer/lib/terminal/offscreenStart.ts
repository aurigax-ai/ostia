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

export function noteFittedGrid(cols: number, rows: number): void {
  if (cols > 0 && rows > 0) lastGrid = { cols, rows }
}

export function offscreenGrid(): Grid {
  return lastGrid ?? DEFAULT_GRID
}

export function startOffscreen(paneId: string, start: OffscreenStart = {}): void {
  const starter = starters.get(paneId)
  if (starter) starter(start)
  else pending.set(paneId, start)
}

export function registerOffscreenStarter(
  paneId: string,
  start: (start: OffscreenStart) => void,
): () => void {
  starters.set(paneId, start)
  const asked = pending.get(paneId)
  if (asked) {
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
}
