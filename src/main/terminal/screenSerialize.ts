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

interface RowStyle {
  sgr: string
  fg: number
  bg: number
}

function cellWords(line: IBufferLine): Uint32Array {
  return (line as unknown as { _line: { _data: Uint32Array } })._line._data
}

function contentEnd(words: Uint32Array, cols: number, blankStyles: boolean): number {
  for (let at = (cols - 1) * CELL_WORDS; at >= 0; at -= CELL_WORDS) {
    const content = words[at]
    if (!blankStyles) {
      const code = content & CONTENT_MASK
      if (code !== 0 && code !== SPACE) return at / CELL_WORDS + 1
      continue
    }
    const fg = words[at + 1]
    const bg = words[at + 2]
    if ((content | fg | bg) === 0) continue
    const code = content & CONTENT_MASK
    if ((code !== 0 && code !== SPACE) || bg & BG_COLOR_MODE || fg & FG_INVERSE) {
      return at / CELL_WORDS + 1
    }
  }
  return 0
}

function serializeRow(
  line: IBufferLine,
  words: Uint32Array,
  stop: number,
  cell: IBufferCell,
  style: RowStyle,
  parts: string[],
): void {
  let runStart = 0
  for (let x = 0; x < stop; x++) {
    const at = x * CELL_WORDS
    if ((words[at] & WIDTH_MASK) === 0) continue
    const fg = words[at + 1]
    const bg = words[at + 2]
    if (fg === style.fg && bg === style.bg) continue
    style.fg = fg
    style.bg = bg
    line.getCell(x, cell)
    const next = cellStyle(cell)
    if (next === style.sgr) continue
    if (x > runStart) parts.push(line.translateToString(false, runStart, x))
    parts.push(next || SGR_RESET)
    style.sgr = next
    runStart = x
  }
  if (stop > runStart) parts.push(line.translateToString(false, runStart, stop))
}

export function serializeLogicalLines(
  buffer: IBuffer,
  start: number,
  end: number,
  blankStyles = true,
): string[] {
  const cell = buffer.getNullCell()
  const lines: string[] = []
  const style: RowStyle = { sgr: '', fg: 0, bg: 0 }
  let parts: string[] = []
  let line = buffer.getLine(start)
  for (let y = start; y <= end; y++) {
    const next = y < end ? buffer.getLine(y + 1) : undefined
    if (line) {
      if (y > start && !line.isWrapped) {
        if (style.sgr) parts.push(SGR_RESET)
        lines.push(parts.join(''))
        parts = []
        style.sgr = ''
        style.fg = 0
        style.bg = 0
      }
      const words = cellWords(line)
      const stop =
        next?.isWrapped === true ? line.length : contentEnd(words, line.length, blankStyles)
      serializeRow(line, words, stop, cell, style, parts)
    }
    line = next
  }
  if (style.sgr) parts.push(SGR_RESET)
  lines.push(parts.join(''))
  return lines
}

export function serializeLines(buffer: IBuffer, start: number, end: number): string {
  return serializeLogicalLines(buffer, start, end).join('\r\n')
}
