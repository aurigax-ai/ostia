import { type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
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

afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    s.close()
  }
  for (const h of hosts.splice(0)) h.closeAll()
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
