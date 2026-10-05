export type PromptStyle = 'shell' | 'ostia'

export interface PromptPlacementInput {
  inputLine: number
  inputCol: number
  viewportY: number
  rows: number
  cols: number
  rightPromptCol: number | null
  style: PromptStyle
  sameLine: boolean
}

export interface PromptPlacement {
  row: number
  col: number
  endCol: number
  chipsRow: number | null
  rowsBelow: number
}

export interface CellMetrics {
  width: number
  height: number
  left: number
  top: number
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export const MIN_INPUT_COLS = 12

export function placePrompt(input: PromptPlacementInput): PromptPlacement | null {
  const { inputLine, inputCol, viewportY, rows, cols, rightPromptCol, style, sameLine } = input
  if (rows <= 0 || cols <= 0) return null
  const row = inputLine - viewportY
  if (row < 0 || row >= rows) return null
  const rowsBelow = rows - 1 - row
  if (style === 'ostia' && sameLine) return { row, col: 0, endCol: cols, chipsRow: null, rowsBelow }
  const col = Math.min(Math.max(0, inputCol), cols - 1)
  if (style === 'ostia') {
    return { row, col, endCol: cols, chipsRow: row === 0 ? null : row - 1, rowsBelow }
  }
  const roomy = rightPromptCol !== null && rightPromptCol - col >= MIN_INPUT_COLS
  const endCol = roomy ? Math.min(rightPromptCol, cols) : cols
  return { row, col, endCol, chipsRow: null, rowsBelow }
}

export function rightPromptStart(cells: readonly string[], from: number): number | null {
  for (let i = Math.max(0, from); i < cells.length; i++) {
    const c = cells[i]
    if (c !== '' && c !== ' ') return i
  }
  return null
}

export function cellBox(metrics: CellMetrics, row: number, col: number, endCol: number): Box {
  return {
    left: metrics.left + col * metrics.width,
    top: metrics.top + row * metrics.height,
    width: Math.max(0, endCol - col) * metrics.width,
    height: metrics.height,
  }
}

export function rowsToMake(visualLines: number, rowsBelow: number, maxLines: number): number {
  const wanted = Math.min(Math.max(1, visualLines), maxLines)
  return Math.max(0, wanted - 1 - rowsBelow)
}

export function scrollUpSequence(
  rows: number,
  cursorRow: number,
  cursorCol: number,
  n: number,
): string {
  if (n <= 0) return ''
  const target = Math.max(0, cursorRow - n)
  return `\x1b[${rows};1H${'\n'.repeat(n)}\x1b[${target + 1};${cursorCol + 1}H`
}
