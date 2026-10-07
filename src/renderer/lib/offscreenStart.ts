export interface Grid {
  cols: number
  rows: number
}

const DEFAULT_GRID: Grid = { cols: 80, rows: 24 }

const starters = new Map<string, () => void>()
const pending = new Set<string>()
let lastGrid: Grid | null = null

export function noteFittedGrid(cols: number, rows: number): void {
  if (cols > 0 && rows > 0) lastGrid = { cols, rows }
}

export function offscreenGrid(): Grid {
  return lastGrid ?? DEFAULT_GRID
}

export function startOffscreen(paneId: string): void {
  const start = starters.get(paneId)
  if (start) start()
  else pending.add(paneId)
}

export function registerOffscreenStarter(paneId: string, start: () => void): () => void {
  starters.set(paneId, start)
  if (pending.delete(paneId)) start()
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
