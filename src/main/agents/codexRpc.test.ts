import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type WebSocket, WebSocketServer } from 'ws'
import { connectCodexRpc } from './codexRpc'

const dir = mkdtempSync(join(tmpdir(), 'ostia-codexrpc-'))
const socket = join(dir, 's.sock')
const received: { id?: number; method?: string; params?: unknown }[] = []
let dropNext = false
let hung: { ws: WebSocket; id: number } | null = null

const server = createServer()
const wss = new WebSocketServer({ server })
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const message = JSON.parse(String(data))
    received.push(message)
    if (message.id === undefined) return
    if (message.method === 'hang') hung = { ws, id: message.id }
    else if (message.method === 'boom')
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
  it('hands the server notifications, with their params, to the listener', async () => {
    const notices: Array<[string, unknown]> = []
    const rpc = await connectCodexRpc(socket, '1', (method, params) =>
      notices.push([method, params]),
    )
    for (const client of wss.clients) {
      client.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'hi' } }))
      client.send(JSON.stringify({ method: 'turn/completed' }))
    }
    await vi.waitFor(() =>
      expect(notices).toEqual([
        ['item/agentMessage/delta', { delta: 'hi' }],
        ['turn/completed', undefined],
      ]),
    )
    rpc.close()
    await rpc.closed
  })

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

  it('ignores a message that is not an object and keeps working', async () => {
    const rpc = await connectCodexRpc(socket, '1')
    for (const client of wss.clients) {
      client.send('null')
      client.send('{not json')
      client.send('7')
    }
    await expect(rpc.request('turn/start', {})).resolves.toEqual({ echoed: 'turn/start' })
    rpc.close()
  })

  it('never answers a server request, and never mistakes one for the reply to its own', async () => {
    received.length = 0
    const rpc = await connectCodexRpc(socket, '1')
    const waiting = rpc.request('hang', {})
    let settled = false
    void waiting.then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(hung).not.toBeNull())
    const { ws, id } = hung as { ws: WebSocket; id: number }
    ws.send(JSON.stringify({ id, method: 'item/commandExecution/requestApproval', params: {} }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(settled).toBe(false)
    expect(received.filter((m) => m.method === undefined)).toEqual([])
    ws.send(JSON.stringify({ id, result: { ok: true } }))
    await expect(waiting).resolves.toEqual({ ok: true })
    rpc.close()
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
