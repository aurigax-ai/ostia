import { type AddressInfo, type Server, connect, createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { holdPort } from './heldPort'

const servers: Server[] = []

function listen(port: number): Promise<number | 'in-use'> {
  const server = createServer()
  servers.push(server)
  return new Promise((resolve) => {
    server.once('error', () => resolve('in-use'))
    server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

async function closeAll(): Promise<void> {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  )
}

afterEach(closeAll)

describe.skipIf(process.platform !== 'linux')('a held port', () => {
  it('answers no connection while it is held', async () => {
    const held = await holdPort()
    try {
      const outcome = await new Promise((resolve) => {
        const socket = connect(held.port, '127.0.0.1')
        socket.once('connect', () => {
          socket.destroy()
          resolve('connected')
        })
        socket.once('error', (err: NodeJS.ErrnoException) => resolve(err.code))
      })
      expect(outcome).toBe('ECONNREFUSED')
    } finally {
      held.release()
    }
  })

  it('is taken by a server that listens on its number, and stays taken after the release', async () => {
    const held = await holdPort()
    await expect(listen(held.port)).resolves.toBe(held.port)
    held.release()
    const other = createServer()
    servers.push(other)
    await expect(
      new Promise((resolve) => {
        other.once('error', (err: NodeJS.ErrnoException) => resolve(err.code))
        other.listen(held.port, '127.0.0.1', () => resolve('listening'))
      }),
    ).resolves.toBe('EADDRINUSE')
  })
})
