import { Transform, type TransformCallback } from 'node:stream'

const MASK_TO_ALLOWED = [true, true, true, false, true, false, false, false]
const MASK_TO_BIT_NUMBER = [0, 1, 2, 2, 3, 3, 3, 3]
const LOOKAHEAD = 4

function isMsByte(byte: number): boolean {
  return byte === 0 || byte === 0xff
}

export class BcjX86State {
  prevMask = 0
  ip = 0
}

export function bcjX86Convert(data: Uint8Array, state: BcjX86State, encoding: boolean): number {
  if (data.length < LOOKAHEAD + 1) return 0
  const ip = state.ip + 5
  let prevMask = state.prevMask & 7
  let prevPos = -1
  let pos = 0
  const limit = data.length - LOOKAHEAD
  for (;;) {
    while (pos < limit && (data[pos] & 0xfe) !== 0xe8) pos++
    if (pos >= limit) break
    const gap = pos - prevPos
    if (gap > 3) prevMask = 0
    else {
      prevMask = (prevMask << (gap - 1)) & 7
      if (prevMask !== 0) {
        const byte = data[pos + 4 - MASK_TO_BIT_NUMBER[prevMask]]
        if (!MASK_TO_ALLOWED[prevMask] || isMsByte(byte)) {
          prevPos = pos
          prevMask = ((prevMask << 1) & 7) | 1
          pos++
          continue
        }
      }
    }
    prevPos = pos
    if (isMsByte(data[pos + 4])) {
      let src =
        ((data[pos + 4] << 24) | (data[pos + 3] << 16) | (data[pos + 2] << 8) | data[pos + 1]) >>> 0
      let dest: number
      for (;;) {
        dest = encoding ? (ip + pos + src) >>> 0 : (src - (ip + pos)) >>> 0
        if (prevMask === 0) break
        const index = MASK_TO_BIT_NUMBER[prevMask] * 8
        const byte = (dest >>> (24 - index)) & 0xff
        if (!isMsByte(byte)) break
        src = (dest ^ (2 ** (32 - index) - 1)) >>> 0
      }
      data[pos + 4] = (dest >>> 24) & 1 ? 0xff : 0
      data[pos + 3] = (dest >>> 16) & 0xff
      data[pos + 2] = (dest >>> 8) & 0xff
      data[pos + 1] = dest & 0xff
      pos += 5
    } else {
      prevMask = ((prevMask << 1) & 7) | 1
      pos++
    }
  }
  const gap = pos - prevPos
  state.prevMask = gap > 3 ? 0 : (prevMask << (gap - 1)) & 7
  state.ip += pos
  return pos
}

export class BcjX86Decoder extends Transform {
  private readonly state = new BcjX86State()
  private held: Buffer = Buffer.alloc(0)

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    const data = Buffer.concat([this.held, chunk])
    const used = bcjX86Convert(data, this.state, false)
    this.push(data.subarray(0, used))
    this.held = Buffer.from(data.subarray(used))
    done()
  }

  override _flush(done: TransformCallback): void {
    this.push(this.held)
    done()
  }
}
