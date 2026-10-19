import type { Socket } from 'node:net'
import { Transform, type TransformCallback } from 'node:stream'
import { CONTROL_MESSAGE_MAX } from '../../shared/control/messageLimit'

const HEADER_MAX = 4096
const CR = 0x0d
const LF = 0x0a

function declaredLength(block: string): number {
  let found: string | null = null
  let count = 0
  const lines = block.split('\r\n')
  for (const line of lines.slice(0, Math.max(0, lines.length - 2))) {
    const colon = line.indexOf(':')
    if (colon === -1) return Number.NaN
    if (line.slice(0, colon).toLowerCase() !== 'content-length') continue
    count += 1
    found = line.slice(colon + 1).trim()
  }
  return count === 1 && found !== null ? Number.parseInt(found) : Number.NaN
}

class MessageCap extends Transform {
  private header: Buffer = Buffer.alloc(0)
  private state = 0
  private remaining = 0

  constructor(
    private readonly max: number,
    private readonly refuse: () => void,
  ) {
    super()
  }

  private headerEnd(chunk: Buffer): number {
    let state = this.state
    for (let at = 0; at < chunk.length; at++) {
      const byte = chunk[at]
      if (byte === CR) state = state === 0 ? 1 : state === 2 ? 3 : 0
      else if (byte === LF) {
        if (state === 3) {
          this.state = 4
          return at + 1
        }
        state = state === 1 ? 2 : 0
      } else state = 0
    }
    this.state = state
    return -1
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    let rest = chunk
    while (rest.length > 0) {
      if (this.remaining > 0) {
        const body = Math.min(this.remaining, rest.length)
        this.remaining -= body
        this.push(rest.subarray(0, body))
        rest = rest.subarray(body)
        continue
      }
      const end = this.headerEnd(rest)
      if (end === -1) {
        this.header = Buffer.concat([this.header, rest])
        if (this.header.length > HEADER_MAX) this.close(done)
        else done()
        return
      }
      const block = Buffer.concat([this.header, rest.subarray(0, end)])
      this.header = Buffer.alloc(0)
      this.state = 0
      const bytes = declaredLength(block.toString('ascii'))
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.max) {
        this.close(done)
        return
      }
      this.push(block)
      this.remaining = bytes
      rest = rest.subarray(end)
    }
    done()
  }

  private close(done: TransformCallback): void {
    this.refuse()
    done(new Error('control message refused'))
  }
}

export function capIncomingMessages(
  socket: Pick<Socket, 'destroy'>,
  max: number = CONTROL_MESSAGE_MAX,
): Transform {
  return new MessageCap(max, () => socket.destroy())
}
