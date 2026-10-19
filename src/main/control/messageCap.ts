import type { Socket } from 'node:net'
import { CONTROL_MESSAGE_MAX } from '../../shared/control/messageLimit'

const HEADER_MAX = 4096
const HEADER_END = Buffer.from('\r\n\r\n')
const LENGTH_HEADER = /^content-length:\s*(\d+)\s*$/im

export function capIncomingMessages(
  socket: Pick<Socket, 'on' | 'destroy'>,
  max: number = CONTROL_MESSAGE_MAX,
): void {
  let header: Buffer = Buffer.alloc(0)
  let remaining = 0
  socket.on('data', (chunk: Buffer) => {
    let rest = chunk
    while (rest.length > 0) {
      if (remaining > 0) {
        const skipped = Math.min(remaining, rest.length)
        remaining -= skipped
        rest = rest.subarray(skipped)
        continue
      }
      header = Buffer.concat([header, rest])
      const end = header.indexOf(HEADER_END)
      if (end < 0) {
        if (header.length > HEADER_MAX) socket.destroy()
        return
      }
      const length = LENGTH_HEADER.exec(header.subarray(0, end).toString('latin1'))?.[1]
      const bytes = length === undefined ? Number.NaN : Number(length)
      if (!Number.isSafeInteger(bytes) || bytes > max) {
        socket.destroy()
        return
      }
      remaining = bytes
      rest = header.subarray(end + HEADER_END.length)
      header = Buffer.alloc(0)
    }
  })
}
