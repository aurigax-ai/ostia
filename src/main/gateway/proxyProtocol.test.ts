import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { type ProxyPeer, readProxyHeader } from './proxyProtocol'

const sockets = new Set<Socket>()
let server: Server | null = null

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

function peerOf(header: string, trailing = ''): Promise<{ peer: ProxyPeer | null; rest: string }> {
  return new Promise((resolve) => {
    server = createServer((socket: Socket) => {
      sockets.add(socket)
      readProxyHeader(socket, (peer, stream) => {
        stream.once('data', (chunk: Buffer) => resolve({ peer, rest: chunk.toString() }))
      })
      socket.once('close', () => resolve({ peer: null, rest: '' }))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const client = connect(port, '127.0.0.1', () => client.write(header + trailing))
      sockets.add(client)
      client.on('error', () => {})
    })
  })
}

describe('the PROXY v1 header', () => {
  it('RLY-C44 reports the sender address and its source port, then passes the rest on', async () => {
    const result = await peerOf('PROXY TCP4 203.0.113.9 127.0.0.1 40000 40000\r\n', 'hello')
    expect(result).toEqual({ peer: { ip: '203.0.113.9', port: 40000 }, rest: 'hello' })
  })

  it('RLY-C45 reads an IPv6 sender', async () => {
    const result = await peerOf('PROXY TCP6 2001:db8::7 ::1 5000 5000\r\n', 'x')
    expect(result.peer).toEqual({ ip: '2001:db8::7', port: 5000 })
  })

  it('RLY-C46 closes on a family that does not match the address', async () => {
    const result = await peerOf('PROXY TCP6 203.0.113.9 127.0.0.1 1 1\r\n', 'x')
    expect(result.peer).toBeNull()
  })
})
