import { APICallError, simulateStreamingMiddleware, wrapLanguageModel } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { type AssistContext, AssistFailure } from '..'
import type { AssistProviderEntry } from '../../../shared/assist'
import type { Provider, ProviderCatalog } from './provider'
import { type AssistServiceOptions, AssistantService } from './service'

const ENV = { XDG_RUNTIME_DIR: '/run/user/1000' }

type Reply = (system: string, modelId: string) => string | Promise<string>

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  }
}

function fakeProvider(
  reply: Reply,
  extra: Partial<Pick<Provider, 'serverCancels' | 'smallPrompts' | 'chatTools'>> = {},
) {
  const calls: { modelId: string; system: string; tools: string[]; last: string }[] = []
  const provider: Provider = {
    kind: 'openai-compatible',
    lifecycle: false,
    serverCancels: true,
    smallPrompts: false,
    chatTools: async () => 'native',
    ...extra,
    model: (modelId) =>
      wrapLanguageModel({
        model: new MockLanguageModelV4({
          modelId,
          doGenerate: async (opts) => {
            const system = opts.prompt
              .filter((m) => m.role === 'system')
              .map((m) => m.content)
              .join('\n')
            calls.push({
              modelId,
              system,
              tools: (opts.tools ?? []).map((t) => t.name),
              last: JSON.stringify(opts.prompt.at(-1)),
            })
            return {
              content: [{ type: 'text', text: await reply(system, modelId) }],
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: usage(),
              warnings: [],
            }
          },
        }),
        middleware: simulateStreamingMiddleware(),
      }),
    models: vi.fn(async () => [{ id: 'm1' }]),
  }
  return { provider, calls }
}

const TARGET = { provider: 'p1', model: 'm' }

function ctx(overrides: Partial<AssistContext> = {}): AssistContext {
  return {
    requestId: 'r1',
    signal: new AbortController().signal,
    chunk: async () => true,
    model: TARGET,
    ...overrides,
  }
}

function entry(kind: string, patch: Partial<AssistProviderEntry> = {}): AssistProviderEntry {
  return { id: 'p1', kind, name: '', baseUrl: '', models: ['m'], apiKey: null, ...patch }
}

const KINDS = ['model-runtime', 'ollama', 'openai-compatible', 'openrouter', 'openai', 'anthropic']

function service(
  provider: Provider,
  now: () => number = () => 0,
  onReport = vi.fn(),
  options: AssistServiceOptions = { configurable: true },
) {
  const factory = vi.fn<ProviderCatalog['create']>(() => provider)
  const catalog: ProviderCatalog = {
    kinds: KINDS,
    keyRequired: new Set(['openrouter', 'openai', 'anthropic']),
    title: (kind, locale) => (locale === 'zh-Hant' ? `${kind}（中）` : kind.toUpperCase()),
    defaultBaseUrl: (kind, env) =>
      kind === 'model-runtime'
        ? `unix:${env.XDG_RUNTIME_DIR}/model-runtime.sock`
        : kind === 'openai-compatible'
          ? ''
          : `https://${kind}.example/v1`,
    create: factory,
  }
  return { svc: new AssistantService(catalog, ENV, now, onReport, options), factory, onReport }
}

async function failureOf(p: Promise<unknown>): Promise<AssistFailure> {
  const err = await p.catch((e) => e)
  expect(err).toBeInstanceOf(AssistFailure)
  return err as AssistFailure
}

const chatInput = { messages: [{ role: 'user' as const, content: 'hi' }], context: [] }

describe('AssistantService report', () => {
  it('is not ready anywhere until a provider is added, and lists every feature', () => {
    const { svc, factory } = service(fakeProvider(() => '').provider)
    svc.configure({}, [])
    const report = svc.report()
    expect(Object.values(report.status).every((s) => s.ready === false)).toBe(true)
    expect(Object.keys(report.status).sort()).toEqual([
      'chat',
      'command',
      'completion',
      'input',
      'terminal',
    ])
    expect(report.setup).toBe('no-provider')
    expect(report.providers).toEqual([])
    expect(report.features?.map((f) => [f.id, f.setting, f.ready])).toEqual([
      ['chat', 'chat', false],
      ['typos', 'typos', false],
      ['promptReview', 'promptReview', false],
      ['commandSuggest', 'commandSuggest', false],
      ['terminalCompletions', 'terminalCompletions', false],
      ['editorCompletions', 'editorCompletions', false],
      ['explainError', 'explainError', false],
    ])
    expect(factory).not.toHaveBeenCalled()
  })

  it('lists the kinds a human can add, titled in their language', () => {
    const { svc } = service(fakeProvider(() => '').provider)
    expect(svc.report().kinds).toContainEqual({
      id: 'openrouter',
      title: 'OPENROUTER',
      baseUrl: 'https://openrouter.example/v1',
      key: 'required',
    })
    expect(svc.report().kinds).toContainEqual({
      id: 'openai-compatible',
      title: 'OPENAI-COMPATIBLE',
      baseUrl: '',
      key: 'optional',
    })
    svc.setLocale('zh-Hant')
    expect(svc.report().kinds?.[0].title).toBe('model-runtime（中）')
    const fixed = service(fakeProvider(() => '').provider, undefined, undefined, {
      listedModels: true,
    })
    expect(fixed.svc.report().kinds).toBeUndefined()
  })

  it('reports every provider with its models, their tool style and what it still needs', async () => {
    const { svc, factory } = service(
      fakeProvider(() => '', { chatTools: async (id) => (id === 'small' ? 'prompted' : 'native') })
        .provider,
    )
    svc.configure({ editorCompletions: false, terminalCompletions: false }, [
      entry('ollama', { id: 'local', name: 'Local', models: ['small', 'big'] }),
      entry('openrouter', { id: 'router', models: ['a/b'] }),
      entry('openai-compatible', { id: 'lab', models: ['x'] }),
      entry('ollama', { id: 'empty', models: [] }),
      entry('not-a-kind', { id: 'other' }),
    ])
    await svc.probe()
    const report = svc.report()
    expect(report.providers).toEqual([
      {
        id: 'local',
        kind: 'ollama',
        name: 'Local',
        setup: null,
        lifecycle: false,
        models: [
          { id: 'small', tools: 'prompted' },
          { id: 'big', tools: 'native' },
        ],
      },
      {
        id: 'router',
        kind: 'openrouter',
        name: 'OPENROUTER',
        setup: 'no-key',
        lifecycle: false,
        models: [{ id: 'a/b' }],
      },
      {
        id: 'lab',
        kind: 'openai-compatible',
        name: 'OPENAI-COMPATIBLE',
        setup: 'no-endpoint',
        lifecycle: false,
        models: [{ id: 'x' }],
      },
      {
        id: 'empty',
        kind: 'ollama',
        name: 'OLLAMA',
        setup: 'no-model',
        lifecycle: false,
        models: [],
      },
    ])
    expect(report.setup).toBeNull()
    expect(report.status).toEqual({
      input: { ready: true },
      command: { ready: true },
      completion: { ready: false },
      terminal: { ready: false },
      chat: { ready: true },
    })
    expect(report.features?.find((f) => f.id === 'terminalCompletions')).toEqual({
      id: 'terminalCompletions',
      setting: 'terminalCompletions',
      ready: false,
      on: false,
    })
    expect(factory).toHaveBeenCalledWith(
      'ollama',
      { origin: 'https://ollama.example', basePath: '/v1' },
      null,
    )
  })

  it('offers what a fixed provider lists as installed, at its default address', async () => {
    const { provider } = fakeProvider(() => '', { chatTools: async () => 'prompted' })
    vi.mocked(provider.models).mockResolvedValue([
      { id: 'gemma', installed: true },
      { id: 'big' },
      { id: 'absent', installed: false },
    ])
    const { svc, factory } = service(provider, undefined, undefined, { listedModels: true })
    svc.configure({}, [entry('model-runtime', { id: 'model-runtime', models: [] })])
    expect(svc.report().setup).toBe('no-model')
    await svc.probe()
    expect(svc.report().providers).toEqual([
      {
        id: 'model-runtime',
        kind: 'model-runtime',
        name: 'MODEL-RUNTIME',
        setup: null,
        lifecycle: false,
        models: [
          { id: 'gemma', tools: 'prompted' },
          { id: 'big', tools: 'prompted' },
        ],
      },
    ])
    expect(factory).toHaveBeenCalledWith(
      'model-runtime',
      {
        socketPath: '/run/user/1000/model-runtime.sock',
        origin: 'http://localhost',
        basePath: '',
      },
      null,
    )
  })

  it('needs a key for hosted providers and a base URL for openai-compatible', () => {
    const { svc } = service(fakeProvider(() => '').provider)
    svc.configure({}, [entry('openrouter')])
    expect(svc.report().setup).toBe('no-key')
    svc.configure({}, [entry('openrouter', { apiKey: '  ' })])
    expect(svc.report().status.chat).toEqual({ ready: false })
    svc.configure({}, [entry('openrouter', { apiKey: 'sk' })])
    expect(svc.report().status.chat).toEqual({ ready: true })
    svc.configure({}, [entry('openai-compatible')])
    expect(svc.report().setup).toBe('no-endpoint')
    svc.configure({}, [entry('openai-compatible', { baseUrl: 'http://h:1/v1' })])
    expect(svc.report().status.chat?.ready).toBe(true)
  })

  it('marks a provider unreachable when the model list probe fails', async () => {
    const { provider } = fakeProvider(() => '')
    vi.mocked(provider.models).mockRejectedValueOnce(new Error('connect ENOENT'))
    const { svc } = service(provider)
    svc.configure({}, [entry('ollama')])
    await svc.probe()
    const report = svc.report()
    expect(report.setup).toBe('unreachable')
    expect(report.providers?.[0]).toMatchObject({
      setup: 'unreachable',
      lastError: 'connect ENOENT',
    })
    expect(report.lastError).toBe('connect ENOENT')
    expect(report.status.chat?.ready).toBe(false)
    await svc.probe()
    expect(svc.report().setup).toBeNull()
  })

  it('keeps chat ready for Explain error when only chat is switched off', () => {
    const { svc } = service(fakeProvider(() => '').provider)
    svc.configure({ chat: false }, [entry('ollama')])
    const report = svc.report()
    expect(report.status.chat?.ready).toBe(true)
    expect(report.features?.find((f) => f.id === 'chat')?.on).toBe(false)
  })
})

describe('AssistantService requests', () => {
  it('refuses a point whose features are off', async () => {
    const { svc } = service(fakeProvider(() => 'x').provider)
    svc.configure({ chat: false, explainError: false }, [entry('ollama')])
    expect((await failureOf(svc.handle('chat', chatInput, ctx()))).code).toBe('unavailable')
  })

  it('refuses a request without a model, for an unknown provider or a model it does not offer', async () => {
    const { svc } = service(fakeProvider(() => 'x').provider)
    svc.configure({}, [entry('ollama')])
    for (const model of [
      undefined,
      { provider: 'nope', model: 'm' },
      { provider: 'p1', model: 'other' },
    ]) {
      expect((await failureOf(svc.handle('chat', chatInput, ctx({ model })))).code).toBe(
        'unavailable',
      )
    }
  })

  it('sends each request to the provider and model it names', async () => {
    const first = fakeProvider(() => 'one')
    const second = fakeProvider(() => 'two')
    const { svc, factory } = service(first.provider)
    factory.mockImplementation((_kind, endpoint) =>
      endpoint.origin === 'http://b:2' ? second.provider : first.provider,
    )
    svc.configure({}, [
      entry('ollama', { id: 'a', models: ['small', 'big'] }),
      entry('openai-compatible', { id: 'b', baseUrl: 'http://b:2/v1', models: ['remote'] }),
    ])
    expect(
      await svc.handle('chat', chatInput, ctx({ model: { provider: 'a', model: 'big' } })),
    ).toEqual({ text: 'one' })
    expect(
      await svc.handle('chat', chatInput, ctx({ model: { provider: 'b', model: 'remote' } })),
    ).toEqual({ text: 'two' })
    expect(first.calls.map((c) => c.modelId)).toEqual(['big'])
    expect(second.calls.map((c) => c.modelId)).toEqual(['remote'])
  })

  it('streams chat as JSON UI message chunks in order and returns the full reply', async () => {
    const { svc } = service(fakeProvider(() => 'Hello world').provider)
    svc.configure({}, [entry('ollama')])
    const chunks: { type: string; delta?: string }[] = []
    const res = await svc.handle(
      'chat',
      chatInput,
      ctx({
        chunk: async (t) => {
          await new Promise((r) => setTimeout(r, 1))
          chunks.push(JSON.parse(t))
          return true
        },
      }),
    )
    expect(res).toEqual({ text: 'Hello world' })
    expect(chunks[0].type).toBe('start')
    expect(chunks.at(-1)?.type).toBe('finish')
    expect(
      chunks
        .filter((c) => c.type === 'text-delta')
        .map((c) => c.delta)
        .join(''),
    ).toBe('Hello world')
  })

  it('declares chat tools natively or in the system prompt, as the provider reports', async () => {
    const tools = [
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]
    const call = '<tool_call>{"name": "read_file", "arguments": {"path": "notes.txt"}}</tool_call>'
    const reply = (system: string) => (system.includes('<tools>') ? call : 'no tools')
    const native = fakeProvider(reply)
    const prompted = fakeProvider(reply, { chatTools: async () => 'prompted' })
    for (const fake of [native, prompted]) {
      const { svc } = service(fake.provider)
      svc.configure({}, [entry('ollama')])
      await svc.probe()
      const chunks: { type: string; toolName?: string; input?: unknown }[] = []
      await svc.handle(
        'chat',
        { ...chatInput, tools },
        ctx({
          chunk: async (t) => {
            chunks.push(JSON.parse(t))
            return true
          },
        }),
      )
      const calls = chunks.filter((c) => c.type === 'tool-input-available')
      if (fake === native) {
        expect(fake.calls[0].tools).toEqual(['read_file'])
        expect(fake.calls[0].system).not.toContain('<tools>')
        expect(calls).toEqual([])
      } else {
        expect(fake.calls[0].tools).toEqual([])
        expect(fake.calls[0].system).toContain('read_file')
        expect(calls).toMatchObject([{ toolName: 'read_file', input: { path: 'notes.txt' } }])
      }
    }
  })

  it('runs one completion at a time on a provider that cannot cancel, dropping stale ones', async () => {
    let release: () => void = () => {}
    const replies = ['first', 'second', 'third']
    const fake = fakeProvider(
      async () => {
        const text = replies.shift() ?? ''
        if (text === 'first') {
          await new Promise<void>((r) => {
            release = r
          })
        }
        return text
      },
      { serverCancels: false },
    )
    const { svc } = service(fake.provider)
    svc.configure({}, [entry('model-runtime')])
    const req = { path: '/a.ts', language: 'typescript', prefix: 'x = ', suffix: '' }
    const stale = new AbortController()
    const first = svc.handle('completion', req, ctx({ signal: stale.signal }))
    await new Promise((r) => setTimeout(r, 5))
    stale.abort()
    expect((await failureOf(first)).code).toBe('cancelled')
    const second = svc.handle('completion', req, ctx())
    const third = svc.handle('completion', req, ctx())
    expect((await failureOf(second)).code).toBe('cancelled')
    expect(fake.calls).toHaveLength(1)
    release()
    expect(await third).toEqual({ text: 'second' })
    expect(fake.calls).toHaveLength(2)
  })

  it('sends a small model-runtime prompt: no other files and a shorter prefix', async () => {
    const req = {
      path: '/a.ts',
      language: 'typescript',
      prefix: `${'p'.repeat(3000)}const x = `,
      suffix: 's'.repeat(1000),
      neighbors: [{ path: '/b.ts', text: 'export const y = 1' }],
    }
    const local = fakeProvider(() => '1', { serverCancels: false, smallPrompts: true })
    const hosted = fakeProvider(() => '1')
    for (const fake of [local, hosted]) {
      const { svc } = service(fake.provider)
      svc.configure({}, [entry('ollama')])
      expect(await svc.handle('completion', req, ctx())).toEqual({ text: '1' })
    }
    expect(local.calls[0].last).not.toContain('/b.ts')
    expect(local.calls[0].last).not.toContain('p'.repeat(2001))
    expect(local.calls[0].last).toContain(`${'p'.repeat(1990)}const x = `)
    expect(hosted.calls[0].last).toContain('/b.ts')
    expect(hosted.calls[0].last).toContain('p'.repeat(3000))
  })

  it('stops sending chunks once the host says nobody listens', async () => {
    const { svc } = service(fakeProvider(() => 'abcdefghi').provider)
    svc.configure({}, [entry('ollama')])
    const chunk = vi.fn(async () => false)
    await svc.handle('chat', chatInput, ctx({ chunk }))
    expect(chunk).toHaveBeenCalledTimes(1)
  })

  it('runs only the input tasks that are on, with the named model', async () => {
    const { provider, calls } = fakeProvider((system) =>
      system.includes('spelling')
        ? 'fix the tests'
        : '```json\n{"score":"2","notes":["Name the file"]}\n```',
    )
    const { svc } = service(provider)
    svc.configure({}, [entry('ollama')])
    expect(
      await svc.handle('input', { text: 'fix teh tests', tasks: ['typos', 'review'] }, ctx()),
    ).toEqual({ corrected: 'fix the tests', review: { score: 2, notes: ['Name the file'] } })
    expect(calls.map((c) => c.modelId)).toEqual(['m', 'm'])
    svc.configure({ promptReview: false }, [entry('ollama')])
    calls.length = 0
    expect(
      (await failureOf(svc.handle('input', { text: 'fix teh tests', tasks: ['review'] }, ctx())))
        .code,
    ).toBe('unavailable')
    expect(calls).toEqual([])
  })

  it('asks once more when the first structured answer is not valid JSON', async () => {
    let n = 0
    const { provider, calls } = fakeProvider(() =>
      n++ === 0 ? '{"suggestions": [{"command": "ls' : '{"suggestions":[{"command":"ls -S"}]}',
    )
    const { svc } = service(provider)
    svc.configure({}, [entry('ollama')])
    expect(await svc.handle('command', { query: 'x' }, ctx())).toEqual({
      suggestions: [{ command: 'ls -S' }],
    })
    expect(calls).toHaveLength(2)
  })

  it('returns no review when the model answers with something that is not one', async () => {
    const { svc } = service(fakeProvider(() => 'looks fine to me').provider)
    svc.configure({}, [entry('ollama')])
    expect(await svc.handle('input', { text: 'x', tasks: ['review'] }, ctx())).toEqual({})
  })

  it('returns command suggestions, cleaned completions and terminal continuations', async () => {
    const { svc } = service(
      fakeProvider((system) => {
        if (system.includes('shell commands'))
          return '{"suggestions":[{"command":"ls -S","description":"by size"}]}'
        if (system.includes('shell prompt')) return 'git commit -m "wip"'
        return '```\n42;\n```'
      }).provider,
    )
    svc.configure({}, [entry('ollama')])
    expect(await svc.handle('command', { query: 'biggest files' }, ctx())).toEqual({
      suggestions: [{ command: 'ls -S', description: 'by size' }],
    })
    expect(
      await svc.handle(
        'completion',
        { path: '/a.ts', language: 'typescript', prefix: 'const x = ', suffix: '' },
        ctx(),
      ),
    ).toEqual({ text: '42;' })
    expect(await svc.handle('terminal', { line: 'git comm' }, ctx())).toEqual({
      text: 'it -m "wip"',
    })
  })

  it('rate-limits each point to requestsPerMinute', async () => {
    let now = 0
    const { svc } = service(fakeProvider(() => '{"suggestions":[]}').provider, () => now)
    svc.configure({ requestsPerMinute: 1 }, [entry('ollama')])
    const ask = () => svc.handle('command', { query: 'x' }, ctx())
    await ask()
    expect((await failureOf(ask())).code).toBe('rate-limited')
    await svc.handle('completion', { path: '/a', language: 'x', prefix: '', suffix: '' }, ctx())
    now = 60_000
    await expect(ask()).resolves.toEqual({ suggestions: [] })
  })

  it('maps provider errors to failures without the API key and reports the last error', async () => {
    const { svc, onReport } = service(
      fakeProvider(() => {
        throw new APICallError({
          message: 'Unauthorized',
          url: 'http://x',
          requestBodyValues: {},
          statusCode: 401,
          responseBody: 'bad key sk-secret-1',
        })
      }).provider,
    )
    svc.configure({}, [entry('openai', { apiKey: 'sk-secret-1' })])
    const err = await failureOf(svc.handle('command', { query: 'x' }, ctx()))
    expect(err.code).toBe('failed')
    expect(err.message).toBe('HTTP 401: bad key ***')
    expect(svc.report().lastError).toBe('HTTP 401: bad key ***')
    expect(onReport).toHaveBeenCalledTimes(1)
  })

  it('reports rate-limited for a 429 from the provider', async () => {
    const { svc } = service(
      fakeProvider(() => {
        throw new APICallError({
          message: 'Too Many Requests',
          url: 'http://x',
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: false,
        })
      }).provider,
    )
    svc.configure({}, [entry('ollama')])
    expect(
      (
        await failureOf(
          svc.handle('completion', { path: '/a', language: 'x', prefix: 'a', suffix: '' }, ctx()),
        )
      ).code,
    ).toBe('rate-limited')
  })

  it('reports cancelled when the request was aborted', async () => {
    const abort = new AbortController()
    const { svc } = service(
      fakeProvider(() => {
        abort.abort()
        throw new Error('socket hang up')
      }).provider,
    )
    svc.configure({}, [entry('ollama')])
    const err = await failureOf(
      svc.handle('command', { query: 'x' }, ctx({ signal: abort.signal })),
    )
    expect(err.code).toBe('cancelled')
  })
})

describe('AssistantService models', () => {
  it('skips listing models without a key and still reports that it lists models', async () => {
    const { provider } = fakeProvider(() => '')
    const { svc } = service(provider)
    svc.configure({}, [entry('anthropic')])
    expect(await svc.modelList('p1')).toEqual({ lifecycle: false, models: [] })
    expect(svc.report().models).toBe(true)
    expect(provider.models).not.toHaveBeenCalled()
  })

  it('lists models and refuses lifecycle calls on providers without one', async () => {
    const { svc } = service(fakeProvider(() => '').provider)
    svc.configure({}, [entry('ollama')])
    expect(await svc.modelList('p1')).toEqual({ lifecycle: false, models: [{ id: 'm1' }] })
    expect(await svc.modelList('nope')).toEqual({ lifecycle: false, models: [] })
    await expect(svc.setLoaded('m1', true, 'p1')).rejects.toThrow(/no model lifecycle/)
  })

  it('reports no model list while no provider is added', () => {
    const { svc } = service(fakeProvider(() => '').provider)
    svc.configure({}, [])
    expect(svc.report().models).toBe(false)
  })
})
