import type { Socket } from 'node:net'
import { CONTROL_MESSAGE_MAX } from '../../shared/control/messageLimit'

const HEADER_MAX = 4096
const HEADER_END = Buffer.from('\r\n\r\n')

function declaredLength(block: string): number {
  let found: string | null = null
  let count = 0
  for (const line of block.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) return Number.NaN
    if (line.slice(0, colon).toLowerCase() !== 'content-length') continue
    count += 1
    found = line.slice(colon + 1).trim()
  }
  return count === 1 && found !== null ? Number.parseInt(found) : Number.NaN
}

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
      const bytes = declaredLength(header.subarray(0, end).toString('ascii'))
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > max) {
        socket.destroy()
        return
      }
      remaining = bytes
      rest = header.subarray(end + HEADER_END.length)
      header = Buffer.alloc(0)
    }
  })
}
