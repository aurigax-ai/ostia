import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeRequest {
  model: string
  stream: boolean
  system: string
  last: string
}

export type FakeAnswer = (req: FakeRequest) => string

export interface FakeProvider {
  server: Server
  url: string
  requests: FakeRequest[]
  close: () => void
}

interface ChatBody {
  model?: string
  stream?: boolean
  messages?: { role: string; content: unknown }[]
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
    const request: FakeRequest = {
      model: body.model ?? '',
      stream: body.stream === true,
      system: messages
        .filter((m) => m.role === 'system')
        .map((m) => text(m.content))
        .join('\n'),
      last: text(messages.filter((m) => m.role === 'user').at(-1)?.content),
    }
    requests.push(request)
    const content = answer(request)
    if (request.stream) stream(res, content)
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
