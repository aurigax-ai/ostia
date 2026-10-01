import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UIMessageChunk } from 'ai'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantService } from '../extensions/assistant/service'
import type { AssistContext } from '../extensions/sdk'
import { type ChatAssistRequest, type ChatToolCall, normalizeAssistRequest } from '../shared/assist'
import { mcpToolName } from '../shared/chatTools'
import { McpHost } from './mcpHost'

const FAKE_SERVER = join(__dirname, '../../test/fixtures/mcp/fake-server.mjs')

interface Body {
  model: string
  stream?: boolean
  tools?: { function: { name: string } }[]
  messages: { role: string; content?: unknown; tool_call_id?: string }[]
}

const servers: Server[] = []
const hosts: McpHost[] = []
const dirs: string[] = []

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    s.close()
  }
  for (const h of hosts.splice(0)) h.closeAll()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function sse(res: ServerResponse, deltas: unknown[], finish: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const base = { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake' }
  for (const delta of deltas) {
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta }] })}\n\n`)
  }
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

function fakeProvider(toolName: string): Promise<{ url: string; bodies: Body[] }> {
  const bodies: Body[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'fake' }] }))
        return
      }
      const body = JSON.parse(raw) as Body
      bodies.push(body)
      const result = body.messages.find((m) => m.role === 'tool')
      if (!result) {
        sse(
          res,
          [
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: toolName, arguments: '' },
                },
              ],
            },
            { tool_calls: [{ index: 0, function: { arguments: '{"text":"from the model"}' } }] },
          ],
          'tool_calls',
        )
        return
      }
      sse(res, [{ role: 'assistant', content: `The tool said: ${String(result.content)}` }], 'stop')
    })
  })
  servers.push(server)
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies }),
    ),
  )
}

async function chat(
  svc: AssistantService,
  request: ChatAssistRequest,
): Promise<{ text: string; chunks: UIMessageChunk[] }> {
  const input = normalizeAssistRequest('chat', request)
  if (!input) throw new Error('invalid request')
  const chunks: UIMessageChunk[] = []
  const ctx: AssistContext = {
    requestId: 'r',
    signal: new AbortController().signal,
    chunk: async (text) => {
      chunks.push(JSON.parse(text) as UIMessageChunk)
      return true
    },
  }
  const result = await svc.handle('chat', input, ctx)
  return { text: result.text, chunks }
}

async function readyHost(): Promise<McpHost> {
  const host = new McpHost({
    servers: () => [
      {
        name: 'fake',
        enabled: true,
        command: [process.execPath, FAKE_SERVER],
        env: {},
        secrets: [],
        disabledTools: [],
      },
    ],
    secret: () => null,
    onStatus: () => {},
  })
  hosts.push(host)
  host.refresh()
  for (let i = 0; i < 300; i++) {
    if (host.status()[0].state === 'ready') return host
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('fake MCP server did not connect')
}

describe('chat tool loop: fake provider, assistant extension and fake MCP server', () => {
  it('streams a tool call, runs the MCP tool and sends its result back to the model', async () => {
    const host = await readyHost()
    const tool = host.status()[0].tools.find((t) => t.name === 'echo')
    if (!tool) throw new Error('echo tool missing')
    const name = mcpToolName('fake', tool.name)
    const provider = await fakeProvider(name)
    const svc = new AssistantService({})
    svc.configure(
      {
        provider: 'openai-compatible',
        baseUrl: provider.url,
        fastModel: 'fake',
        chatModel: 'fake',
      },
      null,
    )
    const tools = [{ name, description: tool.description, inputSchema: tool.inputSchema }]
    const first = await chat(svc, {
      messages: [{ role: 'user', content: 'echo something' }],
      context: [],
      tools,
    })
    expect(provider.bodies[0].tools?.map((t) => t.function.name)).toEqual([name])
    const call = first.chunks.find((c) => c.type === 'tool-input-available')
    expect(call).toMatchObject({
      toolCallId: 'call_1',
      toolName: name,
      input: { text: 'from the model' },
      dynamic: true,
    })
    expect(first.chunks.some((c) => c.type === 'tool-input-delta')).toBe(false)

    const result = await host.call('call_1', 'fake', 'echo', { text: 'from the model' })
    expect(result).toEqual({ ok: true, output: 'echo: from the model' })
    const done: ChatToolCall = {
      id: 'call_1',
      name,
      input: { text: 'from the model' },
      state: 'done',
      output: result.ok ? result.output : '',
    }
    const second = await chat(svc, {
      messages: [
        { role: 'user', content: 'echo something' },
        { role: 'assistant', content: '', tools: [done] },
      ],
      context: [],
      tools,
    })
    const sent = provider.bodies[1].messages
    expect(sent.find((m) => m.role === 'tool')).toMatchObject({
      tool_call_id: 'call_1',
      content: 'echo: from the model',
    })
    expect(second.text).toBe('The tool said: echo: from the model')
  })

  it('tells the model a denied call was denied', async () => {
    const provider = await fakeProvider('write_file')
    const svc = new AssistantService({})
    svc.configure(
      {
        provider: 'openai-compatible',
        baseUrl: provider.url,
        fastModel: 'fake',
        chatModel: 'fake',
      },
      null,
    )
    await chat(svc, {
      messages: [
        { role: 'user', content: 'write it' },
        {
          role: 'assistant',
          content: '',
          tools: [{ id: 'call_1', name: 'write_file', input: { path: '/a' }, state: 'denied' }],
        },
      ],
      context: [],
      tools: [
        {
          name: 'write_file',
          description: 'Write',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    })
    const tool = provider.bodies[0].messages.find((m) => m.role === 'tool')
    expect(String(tool?.content)).toContain('denied')
  })
})

interface RuntimeBody {
  model: string
  stream?: boolean
  tools?: unknown
  messages: { role: string; content: unknown }[]
}

function fakeModelRuntime(replies: string[]): Promise<{ socket: string; bodies: RuntimeBody[] }> {
  const bodies: RuntimeBody[] = []
  const dir = mkdtempSync(join(tmpdir(), 'pine-runtime-'))
  dirs.push(dir)
  const socket = join(dir, 'model-runtime.sock')
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url === '/models') {
        res.end(JSON.stringify({ models: [{ id: 'gemma', installed: true, loaded: true }] }))
        return
      }
      const body = JSON.parse(raw) as RuntimeBody
      bodies.push(body)
      const content = replies[bodies.length - 1] ?? ''
      res.end(
        JSON.stringify({
          id: 'c',
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
    })
  })
  servers.push(server)
  return new Promise((resolve) => server.listen(socket, () => resolve({ socket, bodies })))
}

const READ_FILE = {
  name: 'read_file',
  description: 'Read a text file in the workspace folder.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path' } },
    required: ['path'],
  },
}

const TAGGED_CALL =
  '<tool_call>\n{"name": "read_file", "arguments": {"path": "notes.txt"}}\n</tool_call>'
const TOOL_CODE_CALL =
  'I will read it.\n```tool_code\nprint(default_api.read_file(path="notes.txt"))\n```'

async function runtimeService(socket: string): Promise<AssistantService> {
  const svc = new AssistantService({})
  svc.configure({ provider: 'model-runtime', baseUrl: `unix:${socket}`, chatModel: 'gemma' }, null)
  await svc.probe()
  return svc
}

describe('chat tool loop on model-runtime: tools described in the prompt', () => {
  it.each([
    ['a tagged call', TAGGED_CALL],
    ['a tool_code block', TOOL_CODE_CALL],
  ])('parses %s from the reply and sends the result back as text', async (_label, reply) => {
    const runtime = await fakeModelRuntime([reply, 'The notes say: buy milk.'])
    const svc = await runtimeService(runtime.socket)
    expect(svc.report().status.chat).toMatchObject({ ready: true, tools: 'prompted' })
    const first = await chat(svc, {
      messages: [{ role: 'user', content: 'read notes.txt and summarise' }],
      context: [],
      tools: [READ_FILE],
    })
    const sent = runtime.bodies[0]
    expect(sent.tools).toBeUndefined()
    expect(sent.stream).not.toBe(true)
    expect(sent.messages[0].role).toBe('system')
    expect(String(sent.messages[0].content)).toContain('read_file')
    expect(sent.messages.filter((m) => m.role === 'system')).toHaveLength(1)
    const call = first.chunks.find((c) => c.type === 'tool-input-available')
    expect(call).toMatchObject({ toolName: 'read_file', input: { path: 'notes.txt' } })
    expect(first.text).not.toContain('tool_call')
    if (call?.type !== 'tool-input-available') throw new Error('no tool call')

    const done: ChatToolCall = {
      id: call.toolCallId,
      name: 'read_file',
      input: { path: 'notes.txt' },
      state: 'done',
      output: 'buy milk',
    }
    const second = await chat(svc, {
      messages: [
        { role: 'user', content: 'read notes.txt and summarise' },
        { role: 'assistant', content: '', tools: [done] },
      ],
      context: [],
      tools: [READ_FILE],
    })
    const messages = runtime.bodies[1].messages
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(messages.every((m) => typeof m.content === 'string')).toBe(true)
    expect(String(messages[3].content)).toContain('buy milk')
    expect(second.text).toBe('The notes say: buy milk.')
  })

  it('keeps a reply that only looks like a call as text', async () => {
    const reply = 'Call it like this:\n```tool_code\nread_file(path=\n```'
    const runtime = await fakeModelRuntime([reply])
    const svc = await runtimeService(runtime.socket)
    const res = await chat(svc, {
      messages: [{ role: 'user', content: 'how do I read a file?' }],
      context: [],
      tools: [READ_FILE],
    })
    expect(res.chunks.some((c) => c.type === 'tool-input-available')).toBe(false)
    expect(res.text).toBe(reply)
  })
})
