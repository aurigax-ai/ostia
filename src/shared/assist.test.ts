import { describe, expect, it } from 'vitest'
import {
  CHAT_CONTEXT_TEXT_MAX,
  CHAT_TOOL_OUTPUT_MAX,
  COMPLETION_PREFIX_MAX,
  normalizeAssistRequest,
  normalizeAssistResult,
  normalizeAssistStatus,
} from './assist'

describe('normalizeAssistRequest', () => {
  it('keeps only known typo/review tasks and needs a non-empty draft', () => {
    expect(
      normalizeAssistRequest('input', { text: 'fix teh bug', tasks: ['typos', 'rm'] }),
    ).toEqual({ text: 'fix teh bug', tasks: ['typos'] })
    expect(normalizeAssistRequest('input', { text: '  ', tasks: ['typos'] })).toBeNull()
    expect(normalizeAssistRequest('input', { text: 'x', tasks: [] })).toBeNull()
  })

  it('keeps the tail of a completion prefix, where the cursor is', () => {
    const prefix = `${'a'.repeat(COMPLETION_PREFIX_MAX)}TAIL`
    const req = normalizeAssistRequest('completion', {
      path: '/p/a.ts',
      language: 'typescript',
      prefix,
      suffix: '',
      neighbors: [{ path: '/p/b.ts', text: 'b' }, { path: 5 }],
    })
    expect(req?.prefix.endsWith('TAIL')).toBe(true)
    expect(req?.prefix.length).toBe(COMPLETION_PREFIX_MAX)
    expect(req?.neighbors).toEqual([{ path: '/p/b.ts', text: 'b' }])
  })

  it('needs a chat to end with the human and clips context text', () => {
    expect(
      normalizeAssistRequest('chat', { messages: [{ role: 'assistant', content: 'hi' }] }),
    ).toBeNull()
    expect(
      normalizeAssistRequest('chat', { messages: [{ role: 'system', content: 'x' }] }),
    ).toBeNull()
    const req = normalizeAssistRequest('chat', {
      messages: [{ role: 'user', content: 'why?' }],
      context: [{ kind: 'error', label: 'ls', text: 'e'.repeat(CHAT_CONTEXT_TEXT_MAX + 5) }],
    })
    expect(req?.context[0].text.length).toBe(CHAT_CONTEXT_TEXT_MAX)
  })

  it('keeps attached files and browser pages but drops unknown context kinds', () => {
    const req = normalizeAssistRequest('chat', {
      messages: [{ role: 'user', content: 'summarize' }],
      context: [
        { kind: 'file', label: 'README.md', text: 'hello' },
        { kind: 'browser', label: 'Docs', text: 'Docs\nhttps://example.com' },
        { kind: 'secret', label: 'x', text: 'y' },
      ],
    })
    expect(req?.context.map((c) => c.kind)).toEqual(['file', 'browser'])
  })
})

describe('chat requests with tools', () => {
  const call = (over: Record<string, unknown> = {}) => ({
    id: 't1',
    name: 'read_file',
    input: { path: '/p/a' },
    state: 'done',
    output: 'text',
    ...over,
  })

  it('may end with an assistant turn whose tool calls all have outcomes', () => {
    const req = normalizeAssistRequest('chat', {
      messages: [
        { role: 'assistant', content: 'dropped: a chat starts with the human' },
        { role: 'user', content: 'read a' },
        { role: 'assistant', content: '', tools: [call(), call({ id: 't2', state: 'denied' })] },
      ],
    })
    expect(req?.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(req?.messages[1].tools).toEqual([
      { id: 't1', name: 'read_file', input: { path: '/p/a' }, state: 'done', output: 'text' },
      { id: 't2', name: 'read_file', input: { path: '/p/a' }, state: 'denied' },
    ])
  })

  it('clips tool output, drops calls with a bad name or state, and ignores tools on user turns', () => {
    const req = normalizeAssistRequest('chat', {
      messages: [
        { role: 'user', content: 'x', tools: [call()] },
        {
          role: 'assistant',
          content: '',
          tools: [
            call({ output: 'o'.repeat(CHAT_TOOL_OUTPUT_MAX + 10) }),
            call({ id: 't2', name: 'bad name' }),
            call({ id: 't3', state: 'running' }),
            call({ id: 't4', state: 'error', error: 'nope' }),
          ],
        },
      ],
    })
    expect(req?.messages[0]).toEqual({ role: 'user', content: 'x' })
    const tools = req?.messages[1].tools ?? []
    expect(tools.map((t) => t.id)).toEqual(['t1', 't4'])
    expect(tools[0].output?.length).toBe(CHAT_TOOL_OUTPUT_MAX)
    expect(tools[1]).toMatchObject({ state: 'error', error: 'nope' })
  })

  it('keeps only tool specs with a safe name, a description and an object schema', () => {
    const req = normalizeAssistRequest('chat', {
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        { name: 'read_file', description: 'Read', inputSchema: { type: 'object' } },
        { name: 'read_file', description: 'Dup', inputSchema: { type: 'object' } },
        { name: 'has space', description: 'x', inputSchema: { type: 'object' } },
        { name: 'no_desc', description: ' ', inputSchema: { type: 'object' } },
        { name: 'arr', description: 'x', inputSchema: { type: 'array' } },
      ],
    })
    expect(req?.tools?.map((t) => t.name)).toEqual(['read_file'])
    expect(normalizeAssistRequest('chat', { messages: [{ role: 'user', content: 'x' }] })).toEqual({
      messages: [{ role: 'user', content: 'x' }],
      context: [],
    })
  })
})

describe('normalizeAssistResult', () => {
  it('bounds a prompt review and rounds its score into 1-5', () => {
    expect(
      normalizeAssistResult('input', {
        review: { score: 9.4, notes: ['a', '', 'b', 'c', 'd', 'e', 'f'] },
      }),
    ).toEqual({ review: { score: 5, notes: ['a', 'b', 'c', 'd', 'e'] } })
  })

  it('returns an empty text for a malformed reply', () => {
    expect(normalizeAssistResult('chat', 'nope')).toEqual({ text: '' })
  })
})

describe('normalizeAssistStatus', () => {
  it('keeps known points with a boolean ready and a short label', () => {
    expect(
      normalizeAssistStatus({ chat: { ready: 'yes', label: 'x' }, shell: { ready: true } }),
    ).toEqual({ chat: { ready: false, label: 'x' } })
  })

  it('keeps a known tool mode only on the chat point', () => {
    expect(
      normalizeAssistStatus({
        chat: { ready: true, tools: 'prompted' },
        input: { ready: true, tools: 'native' },
      }),
    ).toEqual({ chat: { ready: true, tools: 'prompted' }, input: { ready: true } })
    expect(normalizeAssistStatus({ chat: { ready: true, tools: true } })).toEqual({
      chat: { ready: true },
    })
  })
})
