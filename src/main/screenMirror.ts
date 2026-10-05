import {
  type IBuffer,
  type IBufferCell,
  type IBufferLine,
  type IMarker,
  Terminal,
} from '@xterm/headless'

const MIRROR_SCROLLBACK = 2000
export const HISTORY_LINES = 1000
const SGR_RESET = '\x1b[0m'
const PROMPT_START = 'A'
const COMMAND_START = 'C'

function isBlank(line: IBufferLine | undefined): boolean {
  return !line || line.translateToString(true).trim() === ''
}

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

function isEmptyCell(cell: IBufferCell): boolean {
  const chars = cell.getChars()
  return (chars === '' || chars === ' ') && cell.isBgDefault() && !cell.isInverse()
}

function contentEnd(line: IBufferLine, cell: IBufferCell): number {
  for (let x = line.length - 1; x >= 0; x--) {
    if (line.getCell(x, cell) && !isEmptyCell(cell)) return x + 1
  }
  return 0
}

function serializeLines(buffer: IBuffer, start: number, end: number): string {
  const cell = buffer.getNullCell()
  let out = ''
  let style = ''
  for (let y = start; y <= end; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    if (y > start && !line.isWrapped) {
      if (style) out += SGR_RESET
      style = ''
      out += '\r\n'
    }
    const continues = y < end && buffer.getLine(y + 1)?.isWrapped === true
    const stop = continues ? line.length : contentEnd(line, cell)
    for (let x = 0; x < stop; x++) {
      if (!line.getCell(x, cell) || cell.getWidth() === 0) continue
      const next = cellStyle(cell)
      if (next !== style) {
        out += next || SGR_RESET
        style = next
      }
      out += cell.getChars() || ' '
    }
  }
  return style ? `${out}${SGR_RESET}` : out
}

export class ScreenMirror {
  private readonly term: Terminal
  private promptStart: IMarker | undefined
  private promptStartCol = 0
  private disposed = false
  private targetCols: number
  private targetRows: number

  constructor(cols: number, rows: number) {
    this.targetCols = Math.max(1, cols)
    this.targetRows = Math.max(1, rows)
    this.term = new Terminal({
      cols: this.targetCols,
      rows: this.targetRows,
      scrollback: MIRROR_SCROLLBACK,
      allowProposedApi: true,
    })
    this.term.parser.registerOscHandler(133, (data) => {
      this.onPromptMark(data.split(';')[0])
      return false
    })
  }

  get cols(): number {
    return this.term.cols
  }

  get rows(): number {
    return this.term.rows
  }

  get bracketedPaste(): boolean {
    return !this.disposed && this.term.modes.bracketedPasteMode
  }

  write(data: string): void {
    if (!this.disposed && data) this.term.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || cols < 1 || rows < 1) return
    if (cols === this.targetCols && rows === this.targetRows) return
    this.targetCols = cols
    this.targetRows = rows
    this.term.write('', () => {
      if (!this.disposed) this.term.resize(cols, rows)
    })
  }

  flush(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return new Promise((resolve) => this.term.write('', resolve))
  }

  serialize(): string {
    if (this.disposed) return ''
    const buffer = this.term.buffer.normal
    const end = this.historyEnd()
    if (end < 0) return ''
    let start = Math.max(0, end - HISTORY_LINES + 1)
    while (start > 0 && buffer.getLine(start)?.isWrapped) start--
    while (start < end && isBlank(buffer.getLine(start)) && !buffer.getLine(start + 1)?.isWrapped) {
      start++
    }
    return serializeLines(buffer, start, end)
  }

  async screenText(maxLines: number): Promise<string> {
    await this.flush()
    if (this.disposed || maxLines < 1) return ''
    const buffer = this.term.buffer.active
    let end = buffer.length - 1
    while (end >= 0 && isBlank(buffer.getLine(end))) end--
    const lines: string[] = []
    for (let y = end; y >= 0 && lines.length < maxLines; y--) {
      let text = ''
      while (y > 0 && buffer.getLine(y)?.isWrapped) {
        text = (buffer.getLine(y)?.translateToString(true) ?? '') + text
        y--
      }
      lines.unshift((buffer.getLine(y)?.translateToString(true) ?? '') + text)
    }
    return lines.join('\n')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearPromptStart()
    this.term.dispose()
  }

  private onPromptMark(kind: string): void {
    if (this.term.buffer.active.type !== 'normal') return
    if (kind === PROMPT_START) {
      this.clearPromptStart()
      this.promptStart = this.term.registerMarker(0)
      this.promptStartCol = this.term.buffer.active.cursorX
    } else if (kind === COMMAND_START) {
      this.clearPromptStart()
    }
  }

  private clearPromptStart(): void {
    this.promptStart?.dispose()
    this.promptStart = undefined
  }

  private historyEnd(): number {
    const buffer = this.term.buffer.normal
    let end = buffer.length - 1
    const mark = this.promptStart
    if (mark && !mark.isDisposed && mark.line >= 0) {
      end = this.promptStartCol > 0 ? mark.line : mark.line - 1
    }
    while (end >= 0 && isBlank(buffer.getLine(end))) end--
    return end
  }
}
