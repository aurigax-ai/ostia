import { mkdtempSync, rmSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AbortedError, HttpError, parseEndpoint } from './http'
import { anthropicDelta, createProvider, openAiDelta } from './providers'

interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Record<string, unknown> | null
}

type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void

const servers: Server[] = []
const dirs: string[] = []

afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function serve(handler: Handler, listen: (s: Server) => Promise<string>) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      const entry: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      }
      seen.push(entry)
      handler(req, res, entry)
    })
  })
  servers.push(server)
  return listen(server).then((base) => ({ base, seen }))
}

function onPort(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`),
    ),
  )
}

function onSocket(server: Server): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-runtime-'))
  dirs.push(dir)
  const path = join(dir, 'model-runtime.sock')
  return new Promise((resolve) => server.listen(path, () => resolve(`unix:${path}`)))
}

function sse(res: ServerResponse, events: string[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const e of events) res.write(`${e}\n\n`)
  res.end()
}

function endpoint(base: string) {
  const parsed = parseEndpoint(base)
  if (!parsed) throw new Error(`bad endpoint ${base}`)
  return parsed
}

const chat = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] }

describe('OpenAI-compatible provider', () => {
  it('streams SSE deltas and returns the whole reply', async () => {
    const { base, seen } = await serve((_req, res) => {
      sse(res, [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}',
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: [DONE]',
      ])
    }, onPort)
    const provider = createProvider('openai-compatible', endpoint(base), 'sk-test')
    const deltas: string[] = []
    const text = await provider.chat({
      ...chat,
      system: 'be brief',
      temperature: 0.2,
      maxTokens: 50,
      onDelta: (d) => deltas.push(d),
    })
    expect(text).toBe('Hello')
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(seen[0].url).toBe('/v1/chat/completions')
    expect(seen[0].headers.authorization).toBe('Bearer sk-test')
    expect(seen[0].body).toMatchObject({
      model: 'm',
      stream: true,
      temperature: 0.2,
      max_tokens: 50,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    })
  })

  it('asks without streaming when nobody listens for deltas', async () => {
    const { base, seen } = await serve((_req, res) => {
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    }, onPort)
    const provider = createProvider('ollama', endpoint(base), null)
    expect(await provider.chat({ ...chat, temperature: 0, maxTokens: 5 })).toBe('ok')
    expect(seen[0].body?.stream).toBe(false)
    expect(seen[0].headers.authorization).toBeUndefined()
  })

  it('turns an error body into an HttpError with the provider message', async () => {
    const { base } = await serve((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
    }, onPort)
    const provider = createProvider('openrouter', endpoint(base), 'k')
    const err = await provider
      .chat({ ...chat, temperature: 0, maxTokens: 5, onDelta: () => {} })
      .catch((e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(401)
    expect(err.message).toBe('HTTP 401: invalid api key')
  })

  it('stops a stream when the signal aborts', async () => {
    const { base } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
    }, onPort)
    const provider = createProvider('openai', endpoint(base), 'k')
    const abort = new AbortController()
    const err = await provider
      .chat({
        ...chat,
        temperature: 0,
        maxTokens: 5,
        signal: abort.signal,
        onDelta: () => abort.abort(),
      })
      .catch((e) => e)
    expect(err).toBeInstanceOf(AbortedError)
  })

  it('lists models and sends the OpenRouter title header', async () => {
    const { base, seen } = await serve((_req, res) => {
      res.end(JSON.stringify({ data: [{ id: 'a/b', name: 'B' }, { id: 'c' }, { name: 'x' }] }))
    }, onPort)
    const provider = createProvider('openrouter', endpoint(base), 'k')
    expect(await provider.models()).toEqual([{ id: 'a/b', name: 'B' }, { id: 'c' }])
    expect(seen[0].url).toBe('/v1/models')
    expect(seen[0].headers['x-title']).toBeTruthy()
  })
})

describe('model-runtime provider', () => {
  it('lists, loads, unloads and chats without streaming over its unix socket', async () => {
    const { base, seen } = await serve((req, res) => {
      if (req.url === '/models') {
        res.end(
          JSON.stringify({
            models: [
              { id: 'pii', installed: true, loaded: false, busy: false },
              { id: 'gemma', installed: true, loaded: true, busy: false, idle_secs: 42 },
            ],
            rss_mb: 10,
          }),
        )
      } else if (req.url?.endsWith('/load') || req.url?.endsWith('/unload')) {
        res.writeHead(204)
        res.end()
      } else {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hej!' } }] }))
      }
    }, onSocket)
    const provider = createProvider('model-runtime', endpoint(base), null)
    expect(provider.lifecycle).toBe(true)
    expect(await provider.models()).toEqual([
      { id: 'pii', installed: true, loaded: false, busy: false },
      { id: 'gemma', installed: true, loaded: true, busy: false, idleSecs: 42 },
    ])
    await provider.load?.('gemma')
    await provider.unload?.('gemma')
    const deltas: string[] = []
    const text = await provider.chat({
      model: 'gemma',
      messages: [{ role: 'user', content: 'Say hi in Danish' }],
      temperature: 0.1,
      maxTokens: 20,
      onDelta: (d) => deltas.push(d),
    })
    expect(text).toBe('Hej!')
    expect(deltas).toEqual(['Hej!'])
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /models',
      'POST /models/gemma/load',
      'POST /models/gemma/unload',
      'POST /v1/chat/completions',
    ])
    expect(seen[3].body?.stream).toBe(false)
  })
})

describe('Anthropic provider', () => {
  it('streams text deltas and sends the system prompt at the top level', async () => {
    const { base, seen } = await serve((_req, res) => {
      sse(res, [
        'event: message_start\ndata: {"type":"message_start","message":{}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ])
    }, onPort)
    const provider = createProvider('anthropic', endpoint(base), 'ak')
    const deltas: string[] = []
    const text = await provider.chat({
      ...chat,
      system: 'sys',
      temperature: 0.3,
      maxTokens: 100,
      onDelta: (d) => deltas.push(d),
    })
    expect(text).toBe('Hi there')
    expect(deltas).toEqual(['Hi', ' there'])
    expect(seen[0].url).toBe('/v1/messages')
    expect(seen[0].headers['x-api-key']).toBe('ak')
    expect(seen[0].headers['anthropic-version']).toBe('2023-06-01')
    expect(seen[0].body).toMatchObject({ system: 'sys', stream: true, max_tokens: 100 })
    expect(seen[0].body?.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('reports an error event from the stream', () => {
    expect(() =>
      anthropicDelta('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
    ).toThrow('Overloaded')
    expect(anthropicDelta('{"type":"ping"}')).toBe('')
  })
})

describe('openAiDelta', () => {
  it('ends at [DONE] and raises provider errors sent mid-stream', () => {
    expect(openAiDelta('[DONE]')).toBeNull()
    expect(() => openAiDelta('{"error":{"message":"quota"}}')).toThrow('quota')
  })
})
