import { type JSONSchema7, dynamicTool, generateText, jsonSchema } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { parseToolCode, withPromptedTools } from './promptedTools'

function replying(text: string) {
  const prompts: unknown[] = []
  const model = new MockLanguageModelV4({
    doGenerate: async (opts) => {
      prompts.push(opts)
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }
    },
  })
  return { model: withPromptedTools(model), prompts }
}

async function callsFor(reply: string) {
  const { model } = replying(reply)
  const res = await generateText({
    model,
    prompt: 'read notes.txt',
    tools: {
      read_file: dynamicTool({
        description: 'Read a file',
        inputSchema: jsonSchema({
          type: 'object',
          properties: { path: { type: 'string' } },
        } as JSONSchema7),
      }),
    },
  })
  return { calls: res.toolCalls.map((c) => [c.toolName, c.input]), text: res.text }
}

const tools = [
  {
    type: 'function' as const,
    name: 'read_file',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer' } },
    },
  },
  {
    type: 'function' as const,
    name: 'write_file',
    description: 'Write a file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
    },
  },
]

describe('parseToolCode', () => {
  it('reads a tool_code block with a print wrapper and the default_api prefix', () => {
    const text = '```tool_code\nprint(default_api.read_file(path="notes.txt"))\n```'
    expect(parseToolCode(text, tools)).toEqual({
      calls: [{ name: 'read_file', input: { path: 'notes.txt' } }],
      text: '',
    })
  })

  it('keeps the prose around the block as text', () => {
    const text =
      "Sure, let me look.\n\n```tool_code\nread_file(path='notes.txt', offset=10)\n```\nOne moment."
    expect(parseToolCode(text, tools)).toEqual({
      calls: [{ name: 'read_file', input: { path: 'notes.txt', offset: 10 } }],
      text: 'Sure, let me look.\n\nOne moment.',
    })
  })

  it('reads a list of calls, escapes and triple-quoted strings', () => {
    const text =
      '```python\n[read_file(path="a.txt"), write_file(path="hello.txt", content="""hi\nthere""")]\n```'
    expect(parseToolCode(text, tools)?.calls).toEqual([
      { name: 'read_file', input: { path: 'a.txt' } },
      { name: 'write_file', input: { path: 'hello.txt', content: 'hi\nthere' } },
    ])
    expect(
      parseToolCode('write_file(path="x", content="a\\nb \\"q\\"")', tools)?.calls[0].input,
    ).toEqual({ path: 'x', content: 'a\nb "q"' })
  })

  it('maps positional arguments to the schema properties in order', () => {
    expect(parseToolCode('read_file("notes.txt", 3)', tools)?.calls).toEqual([
      { name: 'read_file', input: { path: 'notes.txt', offset: 3 } },
    ])
  })

  it('reads a JSON function call inside a tool_code block', () => {
    const text =
      '```tool_code\n{"name": "write_file", "parameters": {"path": "hello.txt", "content": "hi"}}\n```'
    expect(parseToolCode(text, tools)?.calls).toEqual([
      { name: 'write_file', input: { path: 'hello.txt', content: 'hi' } },
    ])
  })

  it('leaves plain answers, unknown functions and malformed calls alone', () => {
    expect(parseToolCode('The file says hello.', tools)).toBeNull()
    expect(parseToolCode('```python\nprint("hello")\n```', tools)).toBeNull()
    expect(parseToolCode('```tool_code\ndelete_all(path="/")\n```', tools)).toBeNull()
    expect(parseToolCode('```tool_code\nread_file(path="notes.txt"\n```', tools)).toBeNull()
    expect(parseToolCode('read_file(path=notes.txt)', tools)).toBeNull()
    expect(parseToolCode('Call read_file(path="x") to read it.', tools)).toBeNull()
  })
})

const TAGGED =
  '<tool_call>\n{"name": "read_file", "arguments": {"path": "notes.txt"}}\n</tool_call>'

describe('withPromptedTools', () => {
  it('turns a tagged call into a tool call, with or without prose around it', async () => {
    expect((await callsFor(TAGGED)).calls).toEqual([['read_file', { path: 'notes.txt' }]])
    const withProse = await callsFor(`Let me read it.\n${TAGGED}`)
    expect(withProse.calls).toEqual([['read_file', { path: 'notes.txt' }]])
    expect(withProse.text).not.toContain('tool_call')
  })

  it('turns fenced JSON and tool_code calls into tool calls', async () => {
    const json = 'JSON:\n```json\n{"name": "read_file", "arguments": {"path": "a.md"}}\n```'
    expect((await callsFor(json)).calls).toEqual([['read_file', { path: 'a.md' }]])
    const code = '```tool_code\nprint(default_api.read_file(path="b.md"))\n```'
    expect((await callsFor(code)).calls).toEqual([['read_file', { path: 'b.md' }]])
  })

  it('falls back to text for a malformed call', async () => {
    const broken = await callsFor('<tool_call>\n{"name": "read_file", "arguments": {"path": \n')
    expect(broken.calls).toEqual([])
    const plain = await callsFor('The notes are about milk.')
    expect(plain).toEqual({ calls: [], text: 'The notes are about milk.' })
  })

  it('describes the tools in the system prompt instead of sending them', async () => {
    const { model, prompts } = replying('ok')
    await generateText({
      model,
      system: 'be brief',
      prompt: 'hi',
      tools: {
        read_file: dynamicTool({
          description: 'Read a file',
          inputSchema: jsonSchema({ type: 'object', properties: {} } as JSONSchema7),
        }),
      },
    })
    const sent = prompts[0] as { tools?: unknown[]; prompt: { role: string; content: unknown }[] }
    expect(sent.tools ?? []).toEqual([])
    expect(sent.prompt[0].role).toBe('system')
    expect(String(sent.prompt[0].content)).toMatch(/be brief[\s\S]*read_file/)
  })
})
