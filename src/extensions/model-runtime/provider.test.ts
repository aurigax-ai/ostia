import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEndpoint } from '@aurigax-ai/pine-extension-sdk/assist'
import { type UIMessageChunk, streamText } from 'ai'
import { afterEach, describe, expect, it } from 'vitest'
import { MODEL_RUNTIME, MODEL_RUNTIME_CATALOG } from './provider'

const servers: Server[] = []
const dirs: string[] = []

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    s.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Seen {
  line: string
  body: Record<string, unknown> | null
}

function runtime(models: object[], reply: string): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      seen.push({ line: `${req.method} ${req.url}`, body: raw ? JSON.parse(raw) : null })
      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ models }))
      } else if (req.url?.startsWith('/models/')) {
        res.writeHead(204)
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'c1',
            object: 'chat.completion',
            created: 1,
            model: 'm',
            choices: [
              { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
      }
    })
  })
  servers.push(server)
  const dir = mkdtempSync(join(tmpdir(), 'model-runtime-'))
  dirs.push(dir)
  const path = join(dir, 'model-runtime.sock')
  return new Promise((resolve) =>
    server.listen(path, () => resolve({ base: `unix:${path}`, seen })),
  )
}

function providerAt(base: string) {
  const endpoint = parseEndpoint(base)
  if (!endpoint) throw new Error(`bad endpoint ${base}`)
  return MODEL_RUNTIME_CATALOG.create(MODEL_RUNTIME, endpoint, null)
}

describe('model-runtime provider', () => {
  it('lists, loads, unloads and chats without streaming over its unix socket', async () => {
    const { base, seen } = await runtime(
      [
        {
          id: 'gemma',
          installed: true,
          loaded: true,
          busy: false,
          idle_secs: 12,
          description: 'chat',
        },
        { id: 'pii', installed: true, loaded: false, busy: false },
      ],
      'Hej!',
    )
    const provider = providerAt(base)
    expect(await provider.models()).toEqual([
      {
        id: 'gemma',
        installed: true,
        loaded: true,
        busy: false,
        idleSecs: 12,
        description: 'chat',
      },
      { id: 'pii', installed: true, loaded: false, busy: false },
    ])
    await provider.load?.('pii')
    await provider.unload?.('gemma')
    const result = streamText({
      model: provider.model('gemma'),
      system: 'be brief',
      messages: [{ role: 'user', content: 'hi' }],
      maxRetries: 0,
    })
    const chunks: UIMessageChunk[] = []
    for await (const c of result.toUIMessageStream()) chunks.push(c)
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta)).toEqual(['Hej!'])
    expect(seen.map((s) => s.line)).toEqual([
      'GET /models',
      'POST /models/pii/load',
      'POST /models/gemma/unload',
      'POST /v1/chat/completions',
    ])
    expect(seen[3]?.body?.stream).not.toBe(true)
  })

  it('describes tools in the prompt, cannot cancel on the server and asks for small prompts', async () => {
    const provider = providerAt('unix:/nowhere.sock')
    expect(await provider.chatTools('gemma')).toBe('prompted')
    expect(provider.serverCancels).toBe(false)
    expect(provider.smallPrompts).toBe(true)
    expect(provider.lifecycle).toBe(true)
  })

  it('defaults to the runtime socket and gemma', () => {
    expect(MODEL_RUNTIME_CATALOG.defaultBaseUrl(MODEL_RUNTIME, { XDG_RUNTIME_DIR: '/run/u' })).toBe(
      'unix:/run/u/model-runtime.sock',
    )
    expect(MODEL_RUNTIME_CATALOG.defaultBaseUrl(MODEL_RUNTIME, {})).toBe('')
    expect(MODEL_RUNTIME_CATALOG.defaultFastModel(MODEL_RUNTIME)).toBe('gemma')
  })
})
