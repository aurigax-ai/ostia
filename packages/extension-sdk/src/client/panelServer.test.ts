import { request } from 'node:http'
import { describe, expect, it } from 'vitest'
import { PANEL_TOOLBAR_PATH } from '../contract/extensionsBridge'
import { startPanelServer } from './index'
import { PANEL_SIZES_PATH } from './split'

const STACK = 'Error: boom\n    at handler (/home/dev/extension/main.js:12:7)'

function post(base: URL, path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: base.port,
        path,
        method: 'POST',
        headers: {
          host: base.host,
          'content-type': 'application/json',
          'x-ostia-panel': base.searchParams.get('t') ?? '',
        },
      },
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

describe('the SDK panel server', () => {
  it('answers a failed API call without the stack of what the handler threw', async () => {
    const thrown: unknown[] = [STACK, { toString: () => STACK }, new Error('boom')]
    let next = 0
    const server = await startPanelServer({
      dir: __dirname,
      files: [],
      handle: async () => {
        throw thrown[next++]
      },
    })
    const base = new URL(server.url({}))
    const replies = []
    for (let i = 0; i < thrown.length; i++) {
      replies.push(await post(base, '/api', JSON.stringify({ command: 'run' })))
    }
    for (const reply of replies) {
      expect(reply.status).toBe(400)
      expect(reply.body).not.toContain('main.js')
    }
    expect(JSON.parse(replies[2].body)).toMatchObject({ ok: false, message: 'boom' })
    expect(JSON.parse((await post(base, '/api', '{')).body)).toMatchObject({ ok: false })
    expect((await post(base, PANEL_SIZES_PATH, '{"key":1}')).status).toBe(400)
  })

  it('hands the page toolbar state to the extension and refuses it without the secret', async () => {
    const seen: unknown[] = []
    const server = await startPanelServer({
      dir: __dirname,
      files: [],
      handle: async () => ({ ok: true }),
      toolbar: async (state) => {
        seen.push(state)
        return { ok: true }
      },
    })
    const base = new URL(server.url({}))
    const reply = await post(base, PANEL_TOOLBAR_PATH, '{"workspaceId":"w1","tab":"vault"}')
    expect(JSON.parse(reply.body)).toEqual({ ok: true })
    expect(seen).toEqual([{ workspaceId: 'w1', tab: 'vault' }])
    const wrong = new URL(base)
    wrong.searchParams.set('t', 'wrong')
    expect((await post(wrong, PANEL_TOOLBAR_PATH, '{}')).status).toBe(403)
    expect(seen).toHaveLength(1)
  })
})
