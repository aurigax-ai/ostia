import { terminalScreen } from './ostiaTerminal'

export interface CellBox {
  cellHeight: number
  originTop: number
}

export interface CellBoxCache {
  get: () => CellBox | null
  invalidate: () => void
}

export function measureCellBox(host: HTMLElement, rows: number): CellBox | null {
  const screen = terminalScreen(host)
  if (!screen || rows <= 0) return null
  const rect = screen.getBoundingClientRect()
  const cellHeight = rect.height / rows
  if (!cellHeight) return null
  const parent = host.parentElement
  const originTop = parent ? rect.top - parent.getBoundingClientRect().top : 0
  return { cellHeight, originTop }
}

export function createCellBoxCache(
  host: HTMLElement,
  rows: () => number,
  measure: (host: HTMLElement, rows: number) => CellBox | null = measureCellBox,
): CellBoxCache {
  let box: CellBox | null = null
  return {
    get: () => {
      box ??= measure(host, rows())
      return box
    },
    invalidate: () => {
      box = null
    },
  }
}
