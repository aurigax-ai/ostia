import { type IBuffer, type IBufferCell, type IBufferLine, ColorKind } from '@aurigax-ai/ghostty-web'

const SGR_RESET = '\x1b[0m'
const SPACE = 32

function colorParams(kind: ColorKind, index: number, rgb: number, fg: boolean): number[] {
  if (kind === ColorKind.RGB) return [fg ? 38 : 48, 2, (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255]
  if (kind !== ColorKind.PALETTE) return []
  if (index < 8) return [(fg ? 30 : 40) + index]
  if (index < 16) return [(fg ? 90 : 100) + index - 8]
  return [fg ? 38 : 48, 5, index]
}

function cellStyle(cell: IBufferCell): string {
  const fgKind = cell.getFgKind()
  const bgKind = cell.getBgKind()
  const flags = [
    cell.isBold(),
    cell.isFaint(),
    cell.isItalic(),
    cell.isUnderline(),
    cell.isBlink(),
    cell.isInverse(),
    cell.isInvisible(),
    cell.isStrikethrough(),
  ]
  if (fgKind === ColorKind.DEFAULT && bgKind === ColorKind.DEFAULT && !flags.some(Boolean)) {
    return ''
  }
  const params = [0]
  const codes = [1, 2, 3, 4, 5, 7, 8, 9]
  flags.forEach((on, i) => {
    if (on) params.push(codes[i])
  })
  params.push(
    ...colorParams(fgKind, cell.getFgPaletteIndex(), cell.getFgColor(), true),
    ...colorParams(bgKind, cell.getBgPaletteIndex(), cell.getBgColor(), false),
  )
  return `\x1b[${params.join(';')}m`
}

function styleKey(cell: IBufferCell): string {
  return `${cell.getFgKind()}:${cell.getFgKind() === ColorKind.PALETTE ? cell.getFgPaletteIndex() : cell.getFgColor()}|${cell.getBgKind()}:${cell.getBgKind() === ColorKind.PALETTE ? cell.getBgPaletteIndex() : cell.getBgColor()}|${cell.isBold()}${cell.isFaint()}${cell.isItalic()}${cell.isUnderline()}${cell.isBlink()}${cell.isInverse()}${cell.isInvisible()}${cell.isStrikethrough()}`
}

interface RowStyle {
  key: string
  sgr: string
}

function contentEnd(line: IBufferLine, blankStyles: boolean): number {
  for (let x = line.length - 1; x >= 0; x--) {
    const cell = line.getCell(x)
    if (!cell) continue
    const code = cell.getCode()
    if (code !== 0 && code !== SPACE) return x + 1
    if (blankStyles && (cell.getBgKind() !== ColorKind.DEFAULT || cell.isInverse())) return x + 1
  }
  return 0
}

function serializeRow(line: IBufferLine, stop: number, style: RowStyle, parts: string[]): void {
  let run = ''
  for (let x = 0; x < stop; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    const key = styleKey(cell)
    if (key !== style.key) {
      const sgr = cellStyle(cell)
      style.key = key
      if (sgr !== style.sgr) {
        if (run) parts.push(run)
        run = ''
        parts.push(sgr || SGR_RESET)
        style.sgr = sgr
      }
    }
    run += cell.getChars() || ' '
  }
  if (run) parts.push(run)
}

export function serializeLogicalLines(
  buffer: IBuffer,
  start: number,
  end: number,
  blankStyles = true,
): string[] {
  const lines: string[] = []
  const style: RowStyle = { key: styleKey(buffer.getNullCell()), sgr: '' }
  const initialKey = style.key
  const parts: string[] = []
  let line = buffer.getLine(start)
  for (let y = start; y <= end; y++) {
    const next = y < end ? buffer.getLine(y + 1) : undefined
    if (line) {
      if (y > start && !line.isWrapped) {
        if (style.sgr) parts.push(SGR_RESET)
        lines.push(parts.join(''))
        parts.length = 0
        style.sgr = ''
        style.key = initialKey
      }
      const stop = next?.isWrapped === true ? line.length : contentEnd(line, blankStyles)
      serializeRow(line, stop, style, parts)
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
