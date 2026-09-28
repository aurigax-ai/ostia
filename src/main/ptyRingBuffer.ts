export class PtyRingBuffer {
  private buf = ''
  private start = 0

  constructor(private readonly capBytes = 1_000_000) {}

  get end(): number {
    return this.start + this.buf.length
  }

  push(data: string): void {
    this.buf += data
    if (this.buf.length > this.capBytes) {
      let cut = this.buf.length - this.capBytes
      const nl = this.buf.indexOf('\n', cut)
      const esc = this.buf.indexOf('\x1b', cut)
      if (nl !== -1 && (esc === -1 || nl <= esc)) cut = nl + 1
      else if (esc !== -1) cut = esc
      this.start += cut
      this.buf = this.buf.slice(cut)
    }
  }

  since(cursor: number): { data: string; cursor: number; dropped: boolean } {
    const dropped = cursor < this.start
    const from = Math.max(0, cursor - this.start)
    return { data: this.buf.slice(from), cursor: this.end, dropped }
  }
}
