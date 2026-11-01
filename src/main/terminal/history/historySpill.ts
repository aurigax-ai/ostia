import type {
  HeadlessTerminal,
  IBufferNamespace,
  IDisposable,
  IMarker,
} from '@aurigax-ai/ghostty-web'
import { decodeCommandLine } from '../../../shared/terminal/commandLine'

export const SPILL_BATCH = 500

export interface SpillSink {
  readonly end: number
  readonly live: boolean
  append(lines: readonly string[]): void
  blockStarted(seq: number, start: number, command: string | null): void
  blockEnded(
    seq: number,
    end: number,
    endCol: number,
    exitCode: number,
    command: string | null,
  ): void
  wipe(): void
  flush(): void
}
export const GAP_LINE = '\x1b[2m── earlier lines not kept ──\x1b[0m'

interface PendingMark {
  kind: 'C' | 'D'
  seq: number
  marker: IMarker
  endCol: number
  exitCode: number
  command: string | null
}

function isAlternateScreenMode(param: number | number[]): boolean {
  const code = Array.isArray(param) ? (param[0] ?? 0) : param
  return code === 47 || code === 1047 || code === 1049
}

function firstParam(params: (number | number[])[]): number {
  const first = params[0]
  return Array.isArray(first) ? (first[0] ?? 0) : (first ?? 0)
}

export class HistorySpill {
  private frontier: IMarker | undefined
  private held = false
  private altTail: string[] | null = null
  private finished = false
  private marks: PendingMark[] = []
  private seq: number
  private running: number | null = null
  private command: string | null = null
  private readonly subs: IDisposable[]
  private readonly buffers: IBufferNamespace

  constructor(
    private readonly term: HeadlessTerminal,
    private readonly history: SpillSink,
    seqOffset: number,
  ) {
    this.buffers = term.buffer
    this.seq = seqOffset
    this.frontier = this.markerAt(0)
    this.subs = [
      term.onScroll(() => this.check()),
      term.parser.registerOscHandler(133, (data) => {
        this.onPromptMark(data)
        return false
      }),
      term.parser.registerOscHandler(633, (data) => {
        if (data.startsWith('E;'))
          this.command = decodeCommandLine(data.slice(2).split(';')[0] ?? '')
        return false
      }),
      term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
        if (params.some(isAlternateScreenMode)) this.altTail = this.tail()
      }),
      term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
        if (params.some(isAlternateScreenMode)) this.altTail = null
      }),
      term.parser.registerCsiHandler({ final: 'J' }, (params) => {
        if (firstParam(params) === 3) this.wipe()
      }),
    ]
  }

  hold(): void {
    this.held = true
  }

  resumeAt(marker: IMarker): void {
    if (!this.held || this.finished) return
    this.held = false
    this.frontier?.dispose()
    this.frontier = this.markerAt(marker.line)
    this.check()
  }

  tail(): string[] {
    const frontier = this.frontier
    if (this.held || this.finished || !frontier || frontier.isDisposed) return []
    if (this.buffers.active.type !== 'normal') return this.altTail ?? []
    const last = this.lastContentRow()
    return last < frontier.line ? [] : this.term.serialize({ from: frontier.line, to: last })
  }

  get seqEnd(): number {
    return this.seq
  }

  lose(): void {
    if (this.finished) return
    if (!this.held && this.buffers.active.type === 'normal') {
      this.spill(this.lastContentRow(), true)
    }
    if (this.history.live) this.history.append([GAP_LINE])
    for (const mark of this.marks) mark.marker.dispose()
    this.marks = []
    this.frontier?.dispose()
    this.frontier = undefined
    this.held = true
  }

  finish(): void {
    if (this.finished) return
    if (!this.held && this.buffers.active.type === 'normal') {
      this.spill(this.lastContentRow(), true)
    }
    this.finished = true
    this.history.flush()
  }

  dispose(): void {
    for (const sub of this.subs) sub.dispose()
    for (const mark of this.marks) mark.marker.dispose()
    this.marks = []
    this.frontier?.dispose()
    this.frontier = undefined
  }

  private lastContentRow(): number {
    const buffer = this.buffers.normal
    let last = buffer.length - 1
    while (last >= 0 && (buffer.getLine(last)?.translateToString(true).trim() ?? '') === '') last--
    return last
  }

  private markerAt(line: number): IMarker | undefined {
    const buffer = this.buffers.normal
    if (this.buffers.active.type !== 'normal') return undefined
    return this.term.registerMarker(line - (buffer.baseY + buffer.cursorY))
  }

  private onPromptMark(data: string): void {
    const [kind, arg] = data.split(';')
    if (kind === 'A') {
      this.command = null
      return
    }
    if (kind !== 'C' && kind !== 'D') return
    if (kind === 'C') {
      this.seq++
      this.running = this.seq
    }
    const seq = kind === 'C' ? this.seq : this.running
    if (kind === 'D') this.running = null
    if (seq === null || this.finished || this.buffers.active.type !== 'normal') return
    const buffer = this.buffers.normal
    const marker = this.term.registerMarker(0)
    if (!marker) return
    this.marks.push({
      kind,
      seq,
      marker,
      endCol: buffer.cursorX,
      exitCode: Number(arg ?? 0) || 0,
      command: this.command,
    })
  }

  private check(): void {
    if (this.held || this.finished || this.buffers.active.type !== 'normal') return
    if (!this.history.live) return
    const frontier = this.frontierLine()
    const baseY = this.buffers.normal.baseY
    if (baseY - frontier >= SPILL_BATCH) this.spill(baseY - 1, false)
  }

  private frontierLine(): number {
    const frontier = this.frontier
    if (frontier && !frontier.isDisposed && frontier.line >= 0) return frontier.line
    this.history.append([GAP_LINE])
    this.frontier = this.markerAt(0)
    return 0
  }

  private spill(lastRow: number, whole: boolean): void {
    if (!this.history.live) return
    const buffer = this.buffers.normal
    const from = this.frontierLine()
    let last = lastRow
    if (!whole) while (last >= from && buffer.getLine(last + 1)?.isWrapped) last--
    if (last < from) return
    const firstLine = this.history.end
    const lines = this.term.serialize({ from, to: last })
    this.history.append(lines)
    this.recordMarks(from, last, firstLine)
    this.frontier?.dispose()
    this.frontier = whole ? undefined : this.markerAt(last + 1)
  }

  pendingEnd(seq: number): { line: number; endCol: number; exitCode: number } | null {
    const frontier = this.frontier
    const mark = this.marks.find((m) => m.kind === 'D' && m.seq === seq && !m.marker.isDisposed)
    if (!mark || !frontier || frontier.isDisposed) return null
    return {
      line: this.logicalLine(frontier.line, mark.marker.line, this.history.end),
      endCol: mark.endCol,
      exitCode: mark.exitCode,
    }
  }

  private logicalLine(from: number, row: number, firstLine: number): number {
    const buffer = this.buffers.normal
    let logical = firstLine
    for (let y = from + 1; y <= row; y++) if (!buffer.getLine(y)?.isWrapped) logical++
    return logical
  }

  private recordMarks(from: number, last: number, firstLine: number): void {
    const kept: PendingMark[] = []
    for (const mark of this.marks) {
      const row = mark.marker.isDisposed ? -1 : mark.marker.line
      if (row > last) {
        kept.push(mark)
        continue
      }
      mark.marker.dispose()
      if (row < from) continue
      const logical = this.logicalLine(from, row, firstLine)
      if (mark.kind === 'C') this.history.blockStarted(mark.seq, logical, mark.command)
      else this.history.blockEnded(mark.seq, logical, mark.endCol, mark.exitCode, mark.command)
    }
    this.marks = kept
  }

  private wipe(): void {
    if (this.buffers.active.type !== 'normal' || this.finished) return
    for (const mark of this.marks) mark.marker.dispose()
    this.marks = []
    this.history.wipe()
    this.frontier?.dispose()
    this.frontier = this.markerAt(this.buffers.normal.baseY)
  }
}
