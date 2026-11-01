import type { HeadlessTerminal, IBufferLine, IMarker } from '@aurigax-ai/ghostty-web'
import { type CwdReport, parseOsc7 } from '../../shared/terminal/osc7'
import type { HistoryFeed } from './history/historyFeed'
import type { PaneBannerText } from './paneBanner'
import { createHeadlessTerminal } from './ghosttyHeadless'
import { serializeLines } from './screenSerialize'

const MIRROR_SCROLLBACK = 4000
export const HISTORY_LINES = 1000
const PROMPT_START = 'A'
const COMMAND_START = 'C'
const seam = (label: string): string => `\x1b]133;D\x07\r\n\x1b[2m── ${label} ──\x1b[0m\r\n`
export const restoreSeam = (t: PaneBannerText): string => seam(t.restored)
export const hibernateSeam = (t: PaneBannerText): string => seam(t.woke)

function isBlank(line: IBufferLine | undefined): boolean {
  return !line || line.translateToString(true).trim() === ''
}

export class ScreenMirror {
  private readonly term: HeadlessTerminal
  private promptStart: IMarker | undefined
  private promptStartCol = 0
  private untouched: { history: string; seamEnd: IMarker; prompted: boolean } | undefined
  private disposed = false
  private targetCols: number
  private targetRows: number
  private changes = 0
  private serialized: { at: number; text: string } | undefined
  private reportedCwd: CwdReport | null = null
  readonly blockSeqBase: number

  constructor(
    cols: number,
    rows: number,
    private readonly feed: HistoryFeed | null = null,
  ) {
    this.targetCols = Math.max(1, cols)
    this.targetRows = Math.max(1, rows)
    this.term = createHeadlessTerminal({
      cols: this.targetCols,
      rows: this.targetRows,
      scrollback: MIRROR_SCROLLBACK,
    })
    this.term.parser.registerOscHandler(133, (data) => {
      this.onPromptMark(data.split(';')[0])
      return false
    })
    this.term.parser.registerOscHandler(7, (data) => {
      this.reportedCwd = parseOsc7(data) ?? this.reportedCwd
      return false
    })
    this.term.onWriteParsed(() => this.changes++)
    this.blockSeqBase = feed?.seqBase ?? 0
    feed?.watchScreen(() => this.serialize())
  }

  get cwdReport(): CwdReport | null {
    return this.reportedCwd
  }

  get revision(): number {
    return this.changes
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
    if (this.disposed || !data) return
    this.term.write(data)
    this.feed?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.disposed || cols < 1 || rows < 1) return
    if (cols === this.targetCols && rows === this.targetRows) return
    this.targetCols = cols
    this.targetRows = rows
    this.feed?.resize(cols, rows)
    this.term.resize(cols, rows)
    this.changes++
  }

  flush(): Promise<void> {
    return Promise.resolve()
  }

  restore(history: string): void {
    if (this.disposed || !history) return
    this.feed?.restore(history)
    this.term.write(`${history}\r\n`)
    this.clearUntouched()
    const seamEnd = this.term.registerMarker(0)
    if (seamEnd) this.untouched = { history, seamEnd, prompted: false }
  }

  async pendingBlockEnd(
    seq: number,
  ): Promise<{ line: number; endCol: number; exitCode: number } | null> {
    return this.disposed ? null : ((await this.feed?.pendingEnd(seq)) ?? null)
  }

  async historyTail(): Promise<string[]> {
    return this.disposed ? [] : ((await this.feed?.tail()) ?? [])
  }

  serialize(): string {
    if (this.disposed) return ''
    if (this.serialized?.at === this.changes) return this.serialized.text
    const text = this.serializeHistory()
    this.serialized = { at: this.changes, text }
    return text
  }

  private serializeHistory(): string {
    const buffer = this.term.buffer.normal
    const end = this.historyEnd()
    const untouched = this.untouched
    if (untouched && !untouched.seamEnd.isDisposed && end < untouched.seamEnd.line) {
      return untouched.history
    }
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
    void this.feed?.close()
    this.clearPromptStart()
    this.clearUntouched()
    this.term.dispose()
  }

  private onPromptMark(kind: string): void {
    if (this.term.buffer.active.type !== 'normal') return
    if (kind === PROMPT_START) {
      this.clearPromptStart()
      this.promptStart = this.term.registerMarker(0)
      this.promptStartCol = this.term.buffer.active.cursorX
      this.skipStartupOutput()
    } else if (kind === COMMAND_START) {
      this.clearPromptStart()
      this.clearUntouched()
    }
  }

  private skipStartupOutput(): void {
    const untouched = this.untouched
    if (!untouched || untouched.prompted) return
    const firstPrompt = this.term.registerMarker(0)
    if (!firstPrompt) return
    untouched.seamEnd.dispose()
    this.untouched = { ...untouched, seamEnd: firstPrompt, prompted: true }
  }

  private clearUntouched(): void {
    this.untouched?.seamEnd.dispose()
    this.untouched = undefined
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
