import type { IBuffer, IBufferCell } from '@xterm/headless'

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
const SINGLE_LATIN1 = 0x400000
const FG_INVERSE = 0x4000000
const BG_COLOR_MODE = 0x3000000

interface RowStyle {
  sgr: string
  fg: number
  bg: number
}

interface RawLine {
  _data: Uint32Array
  isWrapped: boolean
  length: number
  translateToString(trimRight: boolean, start: number, end: number): string
}

function rawLines(buffer: IBuffer): { get(row: number): RawLine | undefined } {
  return (buffer as unknown as { _buffer: { lines: { get(row: number): RawLine | undefined } } })
    ._buffer.lines
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

let latin1 = Buffer.allocUnsafe(256)

function runText(line: RawLine, from: number, to: number): string {
  const words = line._data
  if (latin1.length < to - from) latin1 = Buffer.allocUnsafe(to - from)
  let n = 0
  for (let x = from; x < to; x++) {
    const content = words[x * CELL_WORDS]
    if ((content & ~0xff) !== SINGLE_LATIN1 && content !== 0) {
      return line.translateToString(false, from, to)
    }
    latin1[n++] = content & 0xff || SPACE
  }
  return latin1.toString('latin1', 0, n)
}

function plainRow(line: RawLine, stop: number): string | null {
  const words = line._data
  if (latin1.length < stop) latin1 = Buffer.allocUnsafe(stop)
  for (let x = 0; x < stop; x++) {
    const at = x * CELL_WORDS
    const content = words[at]
    if ((content & ~0xff) !== SINGLE_LATIN1 || (words[at + 1] | words[at + 2]) !== 0) return null
    latin1[x] = content & 0xff || SPACE
  }
  return latin1.toString('latin1', 0, stop)
}

function serializeRow(
  buffer: IBuffer,
  row: number,
  line: RawLine,
  stop: number,
  cell: IBufferCell,
  style: RowStyle,
  parts: string[],
): void {
  const words = line._data
  let runStart = 0
  for (let x = 0; x < stop; x++) {
    const at = x * CELL_WORDS
    if ((words[at] & WIDTH_MASK) === 0) continue
    const fg = words[at + 1]
    const bg = words[at + 2]
    if (fg === style.fg && bg === style.bg) continue
    style.fg = fg
    style.bg = bg
    buffer.getLine(row)?.getCell(x, cell)
    const next = cellStyle(cell)
    if (next === style.sgr) continue
    if (x > runStart) parts.push(runText(line, runStart, x))
    parts.push(next || SGR_RESET)
    style.sgr = next
    runStart = x
  }
  if (stop > runStart) parts.push(runText(line, runStart, stop))
}

export function serializeLogicalLines(
  buffer: IBuffer,
  start: number,
  end: number,
  blankStyles = true,
): string[] {
  const rows = rawLines(buffer)
  const cell = buffer.getNullCell()
  const lines: string[] = []
  const style: RowStyle = { sgr: '', fg: 0, bg: 0 }
  const parts: string[] = []
  let line = rows.get(start)
  for (let y = start; y <= end; y++) {
    const next = y < end ? rows.get(y + 1) : undefined
    if (line) {
      if (y > start && !line.isWrapped) {
        if (style.sgr) parts.push(SGR_RESET)
        lines.push(parts.length === 1 ? parts[0] : parts.join(''))
        parts.length = 0
        style.sgr = ''
        style.fg = 0
        style.bg = 0
      }
      const stop =
        next?.isWrapped === true ? line.length : contentEnd(line._data, line.length, blankStyles)
      const plain = parts.length === 0 && next?.isWrapped !== true ? plainRow(line, stop) : null
      if (plain === null) serializeRow(buffer, y, line, stop, cell, style, parts)
      else parts.push(plain)
    }
    line = next
  }
  if (style.sgr) parts.push(SGR_RESET)
  lines.push(parts.length === 1 ? parts[0] : parts.join(''))
  return lines
}

export function serializeLines(buffer: IBuffer, start: number, end: number): string {
  return serializeLogicalLines(buffer, start, end).join('\r\n')
}
