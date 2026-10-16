import { Terminal } from '@xterm/headless'
import { HistorySpill, SPILL_BATCH, type SpillSink } from './historySpill'

const SPILL_SCROLLBACK = 2 * SPILL_BATCH

export class SpillTerminal {
  private readonly term: Terminal
  private readonly spill: HistorySpill
  private targetCols: number
  private targetRows: number
  private closed = false

  constructor(cols: number, rows: number, sink: SpillSink, seqOffset: number) {
    this.targetCols = Math.max(1, cols)
    this.targetRows = Math.max(1, rows)
    this.term = new Terminal({
      cols: this.targetCols,
      rows: this.targetRows,
      scrollback: SPILL_SCROLLBACK,
      allowProposedApi: true,
    })
    this.spill = new HistorySpill(this.term, sink, seqOffset)
  }

  write(data: Uint8Array): void {
    if (!this.closed && data.length > 0) this.term.write(data)
  }

  restore(history: string, hold: boolean): void {
    if (this.closed || !history) return
    if (hold) this.spill.hold()
    this.term.write(`${history}\r\n`, () => {
      if (this.closed) return
      const seamEnd = this.term.registerMarker(0)
      if (!seamEnd) return
      this.spill.resumeAt(seamEnd)
      seamEnd.dispose()
    })
  }

  resize(cols: number, rows: number): void {
    if (this.closed || cols < 1 || rows < 1) return
    if (cols === this.targetCols && rows === this.targetRows) return
    this.targetCols = cols
    this.targetRows = rows
    this.term.write('', () => {
      if (!this.closed) this.term.resize(cols, rows)
    })
  }

  async tail(): Promise<string[]> {
    await this.parsed()
    return this.closed ? [] : this.spill.tail()
  }

  async pendingEnd(
    seq: number,
  ): Promise<{ line: number; endCol: number; exitCode: number } | null> {
    await this.parsed()
    return this.closed ? null : this.spill.pendingEnd(seq)
  }

  async close(): Promise<void> {
    await this.parsed()
    if (this.closed) return
    this.closed = true
    this.spill.finish()
    this.spill.dispose()
    this.term.dispose()
  }

  private parsed(): Promise<void> {
    if (this.closed) return Promise.resolve()
    return new Promise((resolve) => this.term.write('', resolve))
  }
}
