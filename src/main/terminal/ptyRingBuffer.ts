export function tailCut(data: string, keepBytes: number): number {
  const cut = data.length - keepBytes
  if (cut <= 0) return 0
  const nl = data.indexOf('\n', cut)
  const esc = data.indexOf('\x1b', cut)
  if (nl !== -1 && (esc === -1 || nl <= esc)) return nl + 1
  if (esc !== -1) return esc
  return cut
}

export interface RingSlice {
  data: string
  cursor: number
  dropped: boolean
  startsBefore: number
}

const COMMAND_START_MARK = '\x1b]133;C'

export function countCommandStarts(data: string, end = data.length): number {
  let count = 0
  let at = data.indexOf(COMMAND_START_MARK)
  while (at !== -1 && at + COMMAND_START_MARK.length <= end) {
    count++
    at = data.indexOf(COMMAND_START_MARK, at + COMMAND_START_MARK.length)
  }
  return count
}

export class PtyRingBuffer {
  private buf = ''
  private start: number
  private droppedStarts = 0
  private readonly keepBytes: number

  constructor(
    private readonly capBytes = 1_000_000,
    private readonly base = 0,
  ) {
    this.keepBytes = capBytes - (capBytes >> 2)
    this.start = base
  }

  get end(): number {
    return this.start + this.buf.length
  }

  push(data: string): void {
    this.buf += data
    if (this.buf.length <= this.capBytes) return
    const cut = tailCut(this.buf, this.keepBytes)
    this.droppedStarts += countCommandStarts(this.buf, cut)
    this.start += cut
    this.buf = this.buf.slice(cut)
  }

  since(cursor: number): RingSlice {
    const at = cursor === 0 ? this.base : cursor
    const dropped = at < this.start || at > this.end
    const from = dropped ? 0 : at - this.start
    return {
      data: this.buf.slice(from),
      cursor: this.end,
      dropped,
      startsBefore: this.droppedStarts + countCommandStarts(this.buf, from),
    }
  }
}
