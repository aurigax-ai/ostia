import { request } from 'node:http'
import { connect } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ScreensPanelServer, startPanelServer } from './panelServer'

interface Reply {
  status: number
  body: string
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = ''
        res.on('data', (c: Buffer) => {
          text += c.toString()
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

function rawUpgrade(port: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })
    let text = ''
    socket.on('data', (c: Buffer) => {
      text += c.toString()
    })
    socket.on('close', () => resolve(text))
    socket.on('error', () => resolve(text))
  })
}

describe('the Screens panel server', () => {
  let server: ScreensPanelServer
  const handle = vi.fn(async () => ({ ok: true as const }))
  let base: string

  beforeEach(async () => {
    server = await startPanelServer({ dir: __dirname, files: ['panel.html', 'panel.css'], handle })
    base = new URL(server.open({ workspaceId: 'A', locale: 'en' })).pathname
  })

  afterEach(async () => {
    handle.mockClear()
    await server.close()
  })

  it('serves its page under the panel token path and answers the API for that workspace only', async () => {
    expect((await get(server.port, base)).status).toBe(200)
    const api = await get(
      server.port,
      `${base}api`,
      { 'content-type': 'application/json' },
      'POST',
      JSON.stringify({ command: 'state', args: { workspaceId: 'B' } }),
    )
    expect(api.status).toBe(200)
    expect(handle).toHaveBeenCalledWith(
      'state',
      { workspaceId: 'B' },
      { workspaceId: 'A', locale: 'en', panel: base.split('/')[1] },
    )
  })

  it('SCX-C5 answers 404 or 403 without the token path, with another Host or Origin, or for a file outside its set, and opens no stream', async () => {
    const port = server.port
    const other = `/${'0'.repeat(48)}/`
    for (const path of ['/', '/panel.html', other, `${other}panel.html`, `${other}events`]) {
      expect((await get(port, path)).status, path).toBe(404)
    }
    for (const path of [
      `${base}main.js`,
      `${base}ostia.json`,
      `${base}../panel.html`,
      `${base}%2e%2e/main.js`,
    ]) {
      expect((await get(port, path)).status, path).toBe(404)
    }
    expect((await get(port, base, { host: `localhost:${port}` })).status).toBe(403)
    expect((await get(port, base, { host: 'evil.test' })).status).toBe(403)
    expect((await get(port, base, { origin: 'http://evil.test' })).status).toBe(403)
    expect(
      (
        await get(
          port,
          `${base}api`,
          { 'content-type': 'text/plain' },
          'POST',
          JSON.stringify({ command: 'stop' }),
        )
      ).status,
    ).toBe(415)
    expect(handle).not.toHaveBeenCalled()
    expect(await rawUpgrade(port, `${other}stream`)).not.toContain('101')
  })

  it('answers a failed API call without the stack of what the handler threw', async () => {
    const stack = 'Error: boom\n    at handler (/home/dev/extension/main.js:12:7)'
    const call = () =>
      get(
        server.port,
        `${base}api`,
        { 'content-type': 'application/json' },
        'POST',
        JSON.stringify({ command: 'state' }),
      )
    for (const thrown of [stack, { toString: () => stack }]) {
      handle.mockRejectedValueOnce(thrown)
      const reply = await call()
      expect(reply.status).toBe(400)
      expect(reply.body).not.toContain('main.js')
    }
    handle.mockRejectedValueOnce(new Error('boom'))
    expect(JSON.parse((await call()).body)).toEqual({ ok: false, error: 'boom' })
  })

  it('forgets the panels of a closed workspace', async () => {
    server.forget('A')
    expect((await get(server.port, base)).status).toBe(404)
  })
})
