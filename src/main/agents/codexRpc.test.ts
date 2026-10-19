import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { connectCodexRpc } from './codexRpc'

const dir = mkdtempSync(join(tmpdir(), 'ostia-codexrpc-'))
const socket = join(dir, 's.sock')
const received: { id?: number; method?: string; params?: unknown }[] = []
let dropNext = false

const server = createServer()
const wss = new WebSocketServer({ server })
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const message = JSON.parse(String(data))
    received.push(message)
    if (message.id === undefined) return
    if (message.method === 'boom')
      ws.send(JSON.stringify({ id: message.id, error: { message: 'nope' } }))
    else if (message.method === 'drop') {
      dropNext = true
      ws.close()
    } else ws.send(JSON.stringify({ id: message.id, result: { echoed: message.method } }))
  })
})

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(socket, resolve))
})

afterAll(() => {
  wss.close()
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('connectCodexRpc', () => {
  it('initializes as Ostia, then sends initialized, before it hands the client out', async () => {
    received.length = 0
    const rpc = await connectCodexRpc(socket, '1.2.3')
    expect(received[0]).toMatchObject({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'ostia', version: '1.2.3' } },
    })
    await vi.waitFor(() => expect(received[1]).toEqual({ method: 'initialized' }))
    rpc.close()
    await rpc.closed
  })

  it('answers a request with its result and a refusal as an error', async () => {
    const rpc = await connectCodexRpc(socket, '1')
    await expect(rpc.request('turn/start', { threadId: 't' })).resolves.toEqual({
      echoed: 'turn/start',
    })
    await expect(rpc.request('boom', {})).rejects.toThrow('nope')
    rpc.close()
  })

  it('rejects what was asked when the server drops the connection, and says it closed', async () => {
    const rpc = await connectCodexRpc(socket, '1')
    await expect(rpc.request('drop', {})).rejects.toThrow('closed the connection')
    await rpc.closed
    expect(dropNext).toBe(true)
  })

  it('rejects when nothing listens on the socket', async () => {
    await expect(connectCodexRpc(join(dir, 'missing.sock'), '1')).rejects.toThrow()
  })
})
