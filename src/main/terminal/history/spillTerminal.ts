import type { HeadlessTerminal } from '@aurigax-ai/ghostty-web'
import { createHeadlessTerminal } from '../ghosttyHeadless'
import { HistorySpill, SPILL_BATCH, type SpillSink } from './historySpill'

export const SPILL_SCROLLBACK = 6 * SPILL_BATCH
const MODES_RESET = '\x1b[?1049l\x1b[!p\x1b[0m'

export class SpillTerminal {
  private readonly term: HeadlessTerminal
  private readonly spill: HistorySpill
  private targetCols: number
  private targetRows: number
  private closed = false

  constructor(cols: number, rows: number, sink: SpillSink, seqOffset: number) {
    this.targetCols = Math.max(1, cols)
    this.targetRows = Math.max(1, rows)
    this.term = createHeadlessTerminal({
      cols: this.targetCols,
      rows: this.targetRows,
      scrollback: SPILL_SCROLLBACK,
    })
    this.spill = new HistorySpill(this.term, sink, seqOffset)
  }

  write(data: Uint8Array, parsed: () => void): void {
    if (this.closed) parsed()
    else this.term.write(data, parsed)
  }

  resync(screen: string): void {
    if (this.closed) return
    this.spill.lose()
    this.resumeAfter(`${MODES_RESET}${screen}`)
  }

  restore(history: string, hold: boolean): void {
    if (this.closed || !history) return
    if (hold) this.spill.hold()
    this.resumeAfter(history)
  }

  private resumeAfter(text: string): void {
    this.term.write(`${text}\r\n`)
    const seamEnd = this.term.registerMarker(0)
    if (!seamEnd) return
    this.spill.resumeAt(seamEnd)
    seamEnd.dispose()
  }

  resize(cols: number, rows: number): void {
    if (this.closed || cols < 1 || rows < 1) return
    if (cols === this.targetCols && rows === this.targetRows) return
    this.targetCols = cols
    this.targetRows = rows
    this.term.resize(cols, rows)
  }

  async tail(): Promise<string[]> {
    return this.closed ? [] : this.spill.tail()
  }

  async pendingEnd(
    seq: number,
  ): Promise<{ line: number; endCol: number; exitCode: number } | null> {
    return this.closed ? null : this.spill.pendingEnd(seq)
  }

  async close(): Promise<number> {
    const seqEnd = this.spill.seqEnd
    if (this.closed) return seqEnd
    this.closed = true
    this.spill.finish()
    this.spill.dispose()
    this.term.dispose()
    return seqEnd
  }
}
