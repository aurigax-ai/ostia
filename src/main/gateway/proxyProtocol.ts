import { type Socket, isIP } from 'node:net'
import { Duplex } from 'node:stream'

const PROXY_HEADER_MAX_BYTES = 107
const HEADER_DEADLINE_MS = 10_000
const FAMILY_IP_VERSION: Record<string, 4 | 6> = { TCP4: 4, TCP6: 6 }

function isPort(value: string): boolean {
  if (!/^\d{1,5}$/.test(value)) return false
  return Number(value) <= 65_535
}

function parseProxyLine(line: string): string | null {
  const [tag, family, src, dst, srcPort, dstPort, ...rest] = line.split(' ')
  if (tag !== 'PROXY' || rest.length > 0) return null
  const version = FAMILY_IP_VERSION[family ?? '']
  if (!version || !src || !dst || !srcPort || !dstPort) return null
  if (isIP(src) !== version || isIP(dst) !== version) return null
  if (!isPort(srcPort) || !isPort(dstPort)) return null
  return src
}

class SocketStream extends Duplex {
  constructor(
    private readonly socket: Socket,
    head: Buffer,
  ) {
    super()
    if (head.length > 0) this.push(head)
    socket.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) socket.pause()
    })
    socket.on('end', () => this.push(null))
    socket.on('close', () => this.destroy())
    socket.on('error', (err) => this.destroy(err))
  }

  override _read(): void {
    this.socket.resume()
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (err?: Error | null) => void,
  ): void {
    this.socket.write(chunk, done)
  }

  override _final(done: () => void): void {
    this.socket.end(done)
  }

  override _destroy(err: Error | null, done: (err: Error | null) => void): void {
    this.socket.destroy()
    done(err)
  }
}

export function readProxyHeader(
  socket: Socket,
  onHeader: (peer: string, stream: Duplex) => void,
): void {
  let buffered = Buffer.alloc(0)
  const deadline = setTimeout(() => socket.destroy(), HEADER_DEADLINE_MS)
  socket.on('error', () => socket.destroy())
  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk])
    const end = buffered.indexOf('\r\n')
    if (end === -1) {
      if (buffered.length > PROXY_HEADER_MAX_BYTES) {
        clearTimeout(deadline)
        socket.destroy()
      }
      return
    }
    clearTimeout(deadline)
    socket.off('data', onData)
    socket.pause()
    const peer =
      end + 2 <= PROXY_HEADER_MAX_BYTES
        ? parseProxyLine(buffered.subarray(0, end).toString('latin1'))
        : null
    if (!peer) {
      socket.destroy()
      return
    }
    onHeader(peer, new SocketStream(socket, buffered.subarray(end + 2)))
  }
  socket.on('data', onData)
}
