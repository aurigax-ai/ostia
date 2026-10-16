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
const CELL_WORDS = 3
const CONTENT_MASK = 0x3fffff
const WIDTH_MASK = 0xc00000
const FG_INVERSE = 0x4000000
const BG_COLOR_MODE = 0x3000000

function cellData(line: IBufferLine): Uint32Array {
  return (line as unknown as { _line: { _data: Uint32Array } })._line._data
}

function contentEnd(data: Uint32Array, cols: number): number {
  for (let x = cols - 1; x >= 0; x--) {
    const at = x * CELL_WORDS
    const content = data[at] & CONTENT_MASK
    if (content !== 0 && content !== SPACE) return x + 1
    if (data[at + 2] & BG_COLOR_MODE || data[at + 1] & FG_INVERSE) return x + 1
  }
  return 0
}

function serializeRow(
  line: IBufferLine,
  data: Uint32Array,
  stop: number,
  cell: IBufferCell,
  style: string,
  parts: string[],
): string {
  let current = style
  let runStart = 0
  let fg = Number.NaN
  let bg = Number.NaN
  for (let x = 0; x < stop; x++) {
    const at = x * CELL_WORDS
    if ((data[at] & WIDTH_MASK) === 0) continue
    if (data[at + 1] === fg && data[at + 2] === bg) continue
    fg = data[at + 1]
    bg = data[at + 2]
    line.getCell(x, cell)
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
    const data = cellData(line)
    const stop = continues ? line.length : contentEnd(data, line.length)
    style = serializeRow(line, data, stop, cell, style, parts)
  }
  if (style) parts.push(SGR_RESET)
  lines.push(parts.join(''))
  return lines
}

export function serializeLines(buffer: IBuffer, start: number, end: number): string {
  return serializeLogicalLines(buffer, start, end).join('\r\n')
}
