/**
 * A capped, sequence-numbered byte ring for a pty's output. Keeps the last ~capBytes,
 * trimming ONLY at a safe escape boundary (after a newline, else at an ESC) so a replay
 * never re-parses a fragment of an OSC/CSI sequence (would corrupt xterm's parser and drop
 * a shell-integration mark). `end` is a monotonic stream cursor; `since(cursor)` supports
 * reconnect replay. Ported from the inline logic in main/index.ts.
 */
export class PtyRingBuffer {
  private buf = ''
  /** Stream offset of buf[0] — i.e. bytes dropped from the front so far. */
  private start = 0

  constructor(private readonly capBytes = 1_000_000) {}

  /** Total bytes ever pushed = the next cursor. */
  get end(): number {
    return this.start + this.buf.length
  }

  push(data: string): void {
    this.buf += data
    if (this.buf.length > this.capBytes) {
      // Trim to a safe boundary: never cut an OSC/CSI escape mid-sequence.
      let cut = this.buf.length - this.capBytes
      const nl = this.buf.indexOf('\n', cut)
      const esc = this.buf.indexOf('\x1b', cut)
      if (nl !== -1 && (esc === -1 || nl <= esc)) cut = nl + 1
      else if (esc !== -1) cut = esc
      this.start += cut
      this.buf = this.buf.slice(cut)
    }
  }

  /** Bytes from `cursor` to `end`. `dropped` = the cursor predates the retained window. */
  since(cursor: number): { data: string; cursor: number; dropped: boolean } {
    const dropped = cursor < this.start
    const from = Math.max(0, cursor - this.start)
    return { data: this.buf.slice(from), cursor: this.end, dropped }
  }
}
