import { mkdtempSync, rmSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APICallError, type UIMessageChunk, generateText, streamText } from 'ai'
import { afterEach, describe, expect, it } from 'vitest'
import { parseEndpoint } from './endpoint'
import { createProvider } from './providers'

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
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    s.close()
  }
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

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function completion(content: string) {
  return {
    id: 'c1',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function openAiStream(res: ServerResponse, parts: string[], hold = false): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'm',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  res.write(chunk({ role: 'assistant', content: '' }, null))
  for (const p of parts) res.write(chunk({ content: p }, null))
  if (hold) return
  res.write(chunk({}, 'stop'))
  res.end('data: [DONE]\n\n')
}

function endpoint(base: string) {
  const parsed = parseEndpoint(base)
  if (!parsed) throw new Error(`bad endpoint ${base}`)
  return parsed
}

async function chunksOf(stream: AsyncIterable<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = []
  for await (const c of stream) out.push(c)
  return out
}

const prompt = { system: 'be brief', messages: [{ role: 'user' as const, content: 'hi' }] }

describe('OpenAI-compatible provider', () => {
  it('streams SSE deltas into UI message chunks and the whole reply', async () => {
    const { base, seen } = await serve((_req, res) => openAiStream(res, ['Hel', 'lo']), onPort)
    const provider = createProvider('openai-compatible', endpoint(base), 'sk-1')
    const result = streamText({ model: provider.model('m'), ...prompt, maxRetries: 0 })
    const chunks = await chunksOf(result.toUIMessageStream())
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta)).toEqual(['Hel', 'lo'])
    expect(chunks[0].type).toBe('start')
    expect(chunks.at(-1)?.type).toBe('finish')
    expect(await result.text).toBe('Hello')
    expect(seen[0].url).toBe('/v1/chat/completions')
    expect(seen[0].headers.authorization).toBe('Bearer sk-1')
    expect(seen[0].body).toMatchObject({
      model: 'm',
      stream: true,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    })
  })

  it('answers a non-streaming call', async () => {
    const { base, seen } = await serve((_req, res) => json(res, 200, completion('done')), onPort)
    const provider = createProvider('ollama', endpoint(base), null)
    const res = await generateText({ model: provider.model('m'), ...prompt, maxRetries: 0 })
    expect(res.text).toBe('done')
    expect(seen[0].headers.authorization).toBeUndefined()
  })

  it('raises the provider error body with its status', async () => {
    const { base } = await serve(
      (_req, res) => json(res, 500, { error: { message: 'model exploded' } }),
      onPort,
    )
    const provider = createProvider('openai-compatible', endpoint(base), null)
    const err = await generateText({ model: provider.model('m'), ...prompt, maxRetries: 0 }).catch(
      (e) => e,
    )
    expect(APICallError.isInstance(err)).toBe(true)
    expect((err as APICallError).statusCode).toBe(500)
    expect((err as APICallError).message).toMatch(/model exploded/)
  })

  it('stops a stream when the signal aborts', async () => {
    const { base } = await serve((_req, res) => openAiStream(res, ['a'], true), onPort)
    const provider = createProvider('openai-compatible', endpoint(base), null)
    const abort = new AbortController()
    const result = streamText({
      model: provider.model('m'),
      ...prompt,
      maxRetries: 0,
      abortSignal: abort.signal,
    })
    setTimeout(() => abort.abort(), 50)
    const chunks = await chunksOf(result.toUIMessageStream())
    expect(chunks.some((c) => c.type === 'abort')).toBe(true)
  })

  it('lists models from /models', async () => {
    const { base } = await serve(
      (_req, res) => json(res, 200, { data: [{ id: 'a' }, { id: 'b', name: 'Bee' }, { x: 1 }] }),
      onPort,
    )
    const provider = createProvider('openai-compatible', endpoint(base), null)
    expect(await provider.models()).toEqual([{ id: 'a' }, { id: 'b', name: 'Bee' }])
  })
})

describe('OpenRouter and OpenAI providers', () => {
  it('sends the OpenRouter title header and key to chat completions', async () => {
    const { base, seen } = await serve((_req, res) => json(res, 200, completion('ok')), onPort)
    const provider = createProvider('openrouter', endpoint(base), 'or-key')
    const res = await generateText({ model: provider.model('a/b'), ...prompt, maxRetries: 0 })
    expect(res.text).toBe('ok')
    expect(seen[0].url).toBe('/v1/chat/completions')
    expect(seen[0].headers['x-title']).toBeTruthy()
    expect(seen[0].headers.authorization).toBe('Bearer or-key')
  })

  it('uses chat completions for OpenAI', async () => {
    const { base, seen } = await serve((_req, res) => json(res, 200, completion('ok')), onPort)
    const provider = createProvider('openai', endpoint(base), 'sk-o')
    await generateText({ model: provider.model('gpt'), ...prompt, maxRetries: 0 })
    expect(seen[0].url).toBe('/v1/chat/completions')
    expect(seen[0].headers.authorization).toBe('Bearer sk-o')
  })
})

describe('model-runtime provider', () => {
  it('lists, loads, unloads and chats without streaming over its unix socket', async () => {
    const { base, seen } = await serve((req, res) => {
      if (req.url === '/models') {
        json(res, 200, {
          models: [
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
        })
      } else if (req.url?.startsWith('/models/')) {
        res.writeHead(204)
        res.end()
      } else json(res, 200, completion('Hej!'))
    }, onSocket)
    const provider = createProvider('model-runtime', endpoint(base), null)
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
    const result = streamText({ model: provider.model('gemma'), ...prompt, maxRetries: 0 })
    const chunks = await chunksOf(result.toUIMessageStream())
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta)).toEqual(['Hej!'])
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /models',
      'POST /models/pii/load',
      'POST /models/gemma/unload',
      'POST /v1/chat/completions',
    ])
    expect(seen[3].body?.stream).not.toBe(true)
  })
})

describe('Anthropic provider', () => {
  it('streams text deltas and sends the system prompt at the top level', async () => {
    const events: [string, object][] = [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'm1',
            type: 'message',
            role: 'assistant',
            model: 'claude',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ],
      [
        'content_block_start',
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } },
      ],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ]
    const { base, seen } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const [event, data] of events)
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      res.end()
    }, onPort)
    const provider = createProvider('anthropic', endpoint(base), 'ak')
    const result = streamText({ model: provider.model('claude'), ...prompt, maxRetries: 0 })
    expect(await result.text).toBe('Hi there')
    expect(seen[0].url).toBe('/v1/messages')
    expect(seen[0].headers['x-api-key']).toBe('ak')
    expect(seen[0].body).toMatchObject({ system: [{ type: 'text', text: 'be brief' }] })
  })
})
