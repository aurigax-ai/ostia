import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/headless'

const SGR_RESET = '\x1b[0m'

function colorParams(cell: IBufferCell, fg: boolean): number[] {
  const rgb = fg ? cell.isFgRGB() : cell.isBgRGB()
  const palette = fg ? cell.isFgPalette() : cell.isBgPalette()
  const color = fg ? cell.getFgColor() : cell.getBgColor()
  if (rgb) return [fg ? 38 : 48, 2, (color >> 16) & 255, (color >> 8) & 255, color & 255]
  if (!palette) return []
  if (color < 8) return [(fg ? 30 : 40) + color]
  if (color < 16) return [(fg ? 90 : 100) + color - 8]
  return [fg ? 38 : 48, 5, color]
}

function cellStyle(cell: IBufferCell): string {
  if (cell.isAttributeDefault()) return ''
  const params = [0]
  if (cell.isBold()) params.push(1)
  if (cell.isDim()) params.push(2)
  if (cell.isItalic()) params.push(3)
  if (cell.isUnderline()) params.push(4)
  if (cell.isBlink()) params.push(5)
  if (cell.isInverse()) params.push(7)
  if (cell.isInvisible()) params.push(8)
  if (cell.isStrikethrough()) params.push(9)
  if (cell.isOverline()) params.push(53)
  params.push(...colorParams(cell, true), ...colorParams(cell, false))
  return `\x1b[${params.join(';')}m`
}

const SPACE = 32

function isEmptyCell(cell: IBufferCell): boolean {
  const code = cell.getCode()
  return (code === 0 || code === SPACE) && cell.isBgDefault() && !cell.isInverse()
}

function contentEnd(line: IBufferLine, cell: IBufferCell): number {
  for (let x = line.length - 1; x >= 0; x--) {
    if (line.getCell(x, cell) && !isEmptyCell(cell)) return x + 1
  }
  return 0
}

function serializeRow(
  line: IBufferLine,
  stop: number,
  cell: IBufferCell,
  style: string,
  parts: string[],
): string {
  let current = style
  let runStart = 0
  for (let x = 0; x < stop; x++) {
    if (!line.getCell(x, cell) || cell.getWidth() === 0) continue
    const next = cellStyle(cell)
    if (next === current) continue
    if (x > runStart) parts.push(line.translateToString(false, runStart, x))
    parts.push(next || SGR_RESET)
    current = next
    runStart = x
  }
  if (stop > runStart) parts.push(line.translateToString(false, runStart, stop))
  return current
}

export function serializeLogicalLines(buffer: IBuffer, start: number, end: number): string[] {
  const cell = buffer.getNullCell()
  const lines: string[] = []
  let parts: string[] = []
  let style = ''
  for (let y = start; y <= end; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    if (y > start && !line.isWrapped) {
      if (style) parts.push(SGR_RESET)
      lines.push(parts.join(''))
      parts = []
      style = ''
    }
    const continues = y < end && buffer.getLine(y + 1)?.isWrapped === true
    style = serializeRow(line, continues ? line.length : contentEnd(line, cell), cell, style, parts)
  }
  if (style) parts.push(SGR_RESET)
  lines.push(parts.join(''))
  return lines
}

export function serializeLines(buffer: IBuffer, start: number, end: number): string {
  return serializeLogicalLines(buffer, start, end).join('\r\n')
}
