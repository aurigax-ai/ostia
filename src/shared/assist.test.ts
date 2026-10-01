import { describe, expect, it } from 'vitest'
import {
  ASSIST_PROVIDERS_MAX,
  CHAT_CONTEXT_TEXT_MAX,
  CHAT_TOOL_OUTPUT_MAX,
  COMPLETION_PREFIX_MAX,
  normalizeAssistRequest,
  normalizeAssistResult,
  normalizeAssistStatus,
  normalizeModelRef,
  normalizeProviderKinds,
  normalizeProviderStates,
  parseAssistModelSettings,
  sameModelRef,
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

describe('parseAssistModelSettings', () => {
  const ollama = {
    id: 'ollama',
    extId: 'assistant',
    kind: 'ollama',
    name: 'Ollama',
    baseUrl: '',
    enabled: true,
    models: ['qwen'],
  }

  it('is empty for missing or malformed settings', () => {
    for (const raw of [undefined, null, 'x', [], { providers: 'ollama' }]) {
      expect(parseAssistModelSettings(raw)).toEqual({
        providers: [],
        fastModel: null,
        chatModel: null,
      })
    }
  })

  it('keeps several providers with their own address, switch and models', () => {
    const settings = parseAssistModelSettings({
      providers: [
        ollama,
        {
          id: 'openai-2',
          extId: 'assistant',
          kind: 'openai',
          name: '  Work OpenAI  ',
          baseUrl: ' https://proxy.example/v1 ',
          enabled: false,
          models: ['gpt-a', ' gpt-b ', 'gpt-a', '', 7],
        },
      ],
      chatModel: { extId: 'assistant', provider: 'openai-2', model: 'gpt-a' },
      fastModel: { extId: 'model-runtime', provider: 'model-runtime', model: 'gemma' },
    })
    expect(settings.providers).toEqual([
      ollama,
      {
        id: 'openai-2',
        extId: 'assistant',
        kind: 'openai',
        name: 'Work OpenAI',
        baseUrl: 'https://proxy.example/v1',
        enabled: false,
        models: ['gpt-a', 'gpt-b'],
      },
    ])
    expect(settings.chatModel).toEqual({ extId: 'assistant', provider: 'openai-2', model: 'gpt-a' })
    expect(settings.fastModel).toEqual({
      extId: 'model-runtime',
      provider: 'model-runtime',
      model: 'gemma',
    })
  })

  it('drops providers without a usable id, kind or extension, duplicates and anything past the cap', () => {
    const many = Array.from({ length: ASSIST_PROVIDERS_MAX + 4 }, (_, n) => ({
      ...ollama,
      id: `p${n}`,
    }))
    const settings = parseAssistModelSettings({
      providers: [
        { ...ollama, id: 'Bad Id' },
        { ...ollama, id: '__proto__' },
        { ...ollama, kind: 'Has Space' },
        { ...ollama, extId: '' },
        { ...ollama, baseUrl: 'x'.repeat(5000) },
        ollama,
        { ...ollama, name: 'Duplicate id' },
        ...many,
      ],
    })
    expect(settings.providers).toHaveLength(ASSIST_PROVIDERS_MAX)
    expect(settings.providers[0]).toEqual(ollama)
    expect(settings.providers[1].id).toBe('p0')
  })

  it('never carries a key, whatever the file says', () => {
    const settings = parseAssistModelSettings({
      providers: [{ ...ollama, apiKey: 'sk-in-the-wrong-place', secret: 'x' }],
    })
    expect(JSON.stringify(settings)).not.toContain('sk-in-the-wrong-place')
    expect(Object.keys(settings.providers[0]).sort()).toEqual([
      'baseUrl',
      'enabled',
      'extId',
      'id',
      'kind',
      'models',
      'name',
    ])
  })

  it('reads a model reference to a plain extension or to one provider model', () => {
    expect(normalizeModelRef({ extId: 'oracle' })).toEqual({ extId: 'oracle' })
    expect(normalizeModelRef({ extId: 'a', provider: 'p', model: 'm', extra: 1 })).toEqual({
      extId: 'a',
      provider: 'p',
      model: 'm',
    })
    expect(normalizeModelRef({ extId: 'a', provider: 'Bad Id', model: 'm' })).toEqual({
      extId: 'a',
    })
    expect(normalizeModelRef({ provider: 'p', model: 'm' })).toBeNull()
    expect(normalizeModelRef('a/p/m')).toBeNull()
    expect(sameModelRef({ extId: 'a' }, { extId: 'a' })).toBe(true)
    expect(sameModelRef({ extId: 'a', provider: 'p', model: 'm' }, { extId: 'a' })).toBe(false)
    expect(sameModelRef(null, null)).toBe(true)
  })
})

describe('provider reports', () => {
  it('keeps valid provider states with their models and tool style', () => {
    expect(
      normalizeProviderStates([
        {
          id: 'ollama',
          kind: 'ollama',
          name: 'Ollama',
          setup: 'unreachable',
          lastError: 'connect ENOENT',
          lifecycle: 'yes',
          models: [
            { id: 'qwen', tools: 'prompted' },
            { id: 'qwen' },
            { id: '' },
            { id: 'x', tools: 1 },
          ],
        },
        { id: 'ollama', kind: 'ollama' },
        { id: 'Bad', kind: 'ollama' },
        'nope',
      ]),
    ).toEqual([
      {
        id: 'ollama',
        kind: 'ollama',
        name: 'Ollama',
        setup: 'unreachable',
        lastError: 'connect ENOENT',
        lifecycle: false,
        models: [{ id: 'qwen', tools: 'prompted' }, { id: 'x' }],
      },
    ])
    expect(normalizeProviderStates('x')).toEqual([])
  })

  it('keeps provider kinds with a title, a default address and whether a key is required', () => {
    expect(
      normalizeProviderKinds([
        { id: 'openai', title: 'OpenAI', baseUrl: 'https://api.openai.com/v1', key: 'required' },
        { id: 'ollama' },
        { id: 'openai', title: 'Again' },
        { id: 'No Good' },
      ]),
    ).toEqual([
      { id: 'openai', title: 'OpenAI', baseUrl: 'https://api.openai.com/v1', key: 'required' },
      { id: 'ollama', title: 'ollama', baseUrl: '', key: 'optional' },
    ])
  })
})
