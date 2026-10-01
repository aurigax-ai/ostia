export interface CellBox {
  cellHeight: number
  originTop: number
}

export interface CellBoxCache {
  get: () => CellBox | null
  invalidate: () => void
}

export function measureCellBox(host: HTMLElement): CellBox | null {
  const row = host.querySelector('.xterm-rows > div') as HTMLElement | null
  const cellHeight = row?.offsetHeight ?? 0
  if (!cellHeight) return null
  const screen = host.querySelector('.xterm-screen')
  const parent = host.parentElement
  const originTop =
    screen && parent ? screen.getBoundingClientRect().top - parent.getBoundingClientRect().top : 0
  return { cellHeight, originTop }
}

export function createCellBoxCache(
  host: HTMLElement,
  measure: (host: HTMLElement) => CellBox | null = measureCellBox,
): CellBoxCache {
  let box: CellBox | null = null
  return {
    get: () => {
      box ??= measure(host)
      return box
    },
    invalidate: () => {
      box = null
    },
  }
}
