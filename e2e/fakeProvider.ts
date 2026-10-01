import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeRequest {
  model: string
  stream: boolean
  system: string
  last: string
  tools: string[]
  toolResult?: string
}

export interface FakeToolCall {
  name: string
  args: Record<string, unknown>
}

export type FakeReply = string | { toolCalls: FakeToolCall[] }

export type FakeAnswer = (req: FakeRequest) => FakeReply

export interface FakeProvider {
  server: Server
  url: string
  requests: FakeRequest[]
  close: () => void
}

interface ChatBody {
  model?: string
  stream?: boolean
  tools?: { function?: { name?: string } }[]
  messages?: { role: string; content: unknown }[]
}

let callSeq = 0

function chunk(delta: unknown, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'x',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake',
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
  })}\n\n`
}

function streamToolCalls(res: ServerResponse, calls: FakeToolCall[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  calls.forEach((call, index) => {
    callSeq += 1
    res.write(
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index,
            id: `call_${callSeq}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      }),
    )
  })
  res.write(chunk({}, 'tool_calls'))
  res.write('data: [DONE]\n\n')
  res.end()
}

function text(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'object' && p && 'text' in p ? String(p.text) : ''))
      .join('')
  }
  return ''
}

function readJson(req: IncomingMessage): Promise<ChatBody> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => resolve(JSON.parse(raw || '{}') as ChatBody))
  })
}

function reply(res: ServerResponse, content: string): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      id: 'x',
      object: 'chat.completion',
      created: 1,
      model: 'fake',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    }),
  )
}

function stream(res: ServerResponse, content: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const parts = content.match(/[\s\S]{1,12}/g) ?? ['']
  let i = 0
  const next = (): void => {
    if (i < parts.length) {
      const delta = {
        id: 'x',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fake',
        choices: [{ index: 0, delta: { content: parts[i++] } }],
      }
      res.write(`data: ${JSON.stringify(delta)}\n\n`)
      setTimeout(next, 40)
    } else {
      const done = {
        id: 'x',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fake',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }
      res.write(`data: ${JSON.stringify(done)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }
  next()
}

export function startFakeProvider(answer: FakeAnswer): Promise<FakeProvider> {
  const requests: FakeRequest[] = []
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fake-small' }, { id: 'fake-big' }] }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404)
      res.end()
      return
    }
    const body = await readJson(req)
    const messages = body.messages ?? []
    const lastUser = messages.map((m) => m.role).lastIndexOf('user')
    const toolAfterUser = messages.slice(lastUser + 1).filter((m) => m.role === 'tool')
    const request: FakeRequest = {
      model: body.model ?? '',
      stream: body.stream === true,
      system: messages
        .filter((m) => m.role === 'system')
        .map((m) => text(m.content))
        .join('\n'),
      last: text(messages.filter((m) => m.role === 'user').at(-1)?.content),
      tools: (body.tools ?? []).map((t) => t.function?.name ?? ''),
      ...(toolAfterUser.length > 0 ? { toolResult: text(toolAfterUser.at(-1)?.content) } : {}),
    }
    requests.push(request)
    const content = answer(request)
    if (typeof content !== 'string') streamToolCalls(res, content.toolCalls)
    else if (request.stream) stream(res, content)
    else reply(res, content)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        server,
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => server.close(),
      })
    })
  })
}

export interface SeededProvider {
  id: string
  name: string
  url: string
  models: string[]
}

export function assistantModelSettings(
  providers: SeededProvider[],
  fast: { provider: string; model: string },
  chat: { provider: string; model: string },
): object {
  return {
    providers: providers.map((p) => ({
      id: p.id,
      extId: 'assistant',
      kind: 'openai-compatible',
      name: p.name,
      baseUrl: p.url,
      enabled: true,
      models: p.models,
    })),
    fastModel: { extId: 'assistant', ...fast },
    chatModel: { extId: 'assistant', ...chat },
  }
}

export function fakeAssistantSettings(url: string): object {
  return assistantModelSettings(
    [{ id: 'fake', name: 'Fake', url, models: ['fake-small', 'fake-big'] }],
    { provider: 'fake', model: 'fake-small' },
    { provider: 'fake', model: 'fake-big' },
  )
}
