export function tailCut(data: string, keepBytes: number): number {
  const cut = data.length - keepBytes
  if (cut <= 0) return 0
  const nl = data.indexOf('\n', cut)
  const esc = data.indexOf('\x1b', cut)
  if (nl !== -1 && (esc === -1 || nl <= esc)) return nl + 1
  if (esc !== -1) return esc
  return cut
}

export class PtyRingBuffer {
  private buf = ''
  private start = 0
  private readonly keepBytes: number

  constructor(private readonly capBytes = 1_000_000) {
    this.keepBytes = capBytes - (capBytes >> 2)
  }

  get end(): number {
    return this.start + this.buf.length
  }

  push(data: string): void {
    this.buf += data
    if (this.buf.length <= this.capBytes) return
    const cut = tailCut(this.buf, this.keepBytes)
    this.start += cut
    this.buf = this.buf.slice(cut)
  }

  since(cursor: number): { data: string; cursor: number; dropped: boolean } {
    const dropped = cursor < this.start
    const from = Math.max(0, cursor - this.start)
    return { data: this.buf.slice(from), cursor: this.end, dropped }
  }
}
