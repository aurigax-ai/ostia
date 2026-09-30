import { APICallError, simulateStreamingMiddleware, wrapLanguageModel } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { type AssistContext, AssistFailure } from '../sdk'
import type { Provider } from './providers'
import { AssistantService } from './service'

const ENV = { XDG_RUNTIME_DIR: '/run/user/1000' }

type Reply = (system: string, modelId: string) => string

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  }
}

function fakeProvider(reply: Reply) {
  const calls: { modelId: string; system: string }[] = []
  const provider: Provider = {
    kind: 'openai-compatible',
    lifecycle: false,
    model: (modelId) =>
      wrapLanguageModel({
        model: new MockLanguageModelV4({
          modelId,
          doGenerate: async (opts) => {
            const system = opts.prompt
              .filter((m) => m.role === 'system')
              .map((m) => m.content)
              .join('\n')
            calls.push({ modelId, system })
            return {
              content: [{ type: 'text', text: reply(system, modelId) }],
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

function ctx(overrides: Partial<AssistContext> = {}): AssistContext {
  return {
    requestId: 'r1',
    signal: new AbortController().signal,
    chunk: async () => true,
    ...overrides,
  }
}

function service(provider: Provider, now: () => number = () => 0, onReport = vi.fn()) {
  const factory = vi.fn(() => provider)
  return { svc: new AssistantService(ENV, factory, now, onReport), factory, onReport }
}

async function failureOf(p: Promise<unknown>): Promise<AssistFailure> {
  const err = await p.catch((e) => e)
  expect(err).toBeInstanceOf(AssistFailure)
  return err as AssistFailure
}

const chatInput = { messages: [{ role: 'user' as const, content: 'hi' }], context: [] }

describe('AssistantService report', () => {
  it('is not ready anywhere until a provider is picked, and lists every feature', () => {
    const { svc, factory } = service(fakeProvider(() => '').provider)
    svc.configure({ provider: 'none', fastModel: 'x' }, null)
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
    expect(report.features?.map((f) => [f.id, f.setting, f.ready])).toEqual([
      ['chat', 'chat', false],
      ['typos', 'typos', false],
      ['promptReview', 'promptReview', false],
      ['commandSuggest', 'commandSuggest', false],
      ['terminalCompletions', 'terminalCompletions', false],
      ['editorCompletions', 'editorCompletions', false],
      ['explainError', 'explainError', false],
    ])
    expect(report.label).toBeUndefined()
    expect(factory).not.toHaveBeenCalled()
  })

  it('labels points with provider and model, gemma by default on model-runtime', () => {
    const { svc, factory } = service(fakeProvider(() => '').provider)
    svc.configure(
      {
        provider: 'model-runtime',
        chatModel: 'big',
        editorCompletions: false,
        terminalCompletions: false,
      },
      null,
    )
    const report = svc.report()
    expect(report.status).toEqual({
      input: { ready: true, label: 'model-runtime · gemma' },
      command: { ready: true, label: 'model-runtime · gemma' },
      completion: { ready: false },
      terminal: { ready: false },
      chat: { ready: true, label: 'model-runtime · big', tools: true },
    })
    expect(report.label).toBe('model-runtime · gemma / big')
    expect(report.features?.find((f) => f.id === 'terminalCompletions')).toEqual({
      id: 'terminalCompletions',
      setting: 'terminalCompletions',
      ready: false,
      on: false,
    })
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
    svc.configure({ provider: 'openrouter', fastModel: 'a/b' }, null)
    expect(svc.report().setup).toBe('no-key')
    svc.configure({ provider: 'openrouter', fastModel: 'a/b' }, '  ')
    expect(svc.report().status.chat).toEqual({ ready: false })
    svc.configure({ provider: 'openrouter', fastModel: 'a/b' }, 'sk')
    expect(svc.report().status.chat).toEqual({
      ready: true,
      label: 'openrouter · a/b',
      tools: true,
    })
    svc.configure({ provider: 'openai-compatible', fastModel: 'm' }, null)
    expect(svc.report().setup).toBe('no-endpoint')
    svc.configure({ provider: 'openai-compatible', fastModel: 'm', baseUrl: 'http://h:1/v1' }, null)
    expect(svc.report().status.chat?.ready).toBe(true)
  })

  it('marks the provider unreachable when the model list probe fails', async () => {
    const { provider } = fakeProvider(() => '')
    vi.mocked(provider.models).mockRejectedValueOnce(new Error('connect ENOENT'))
    const { svc } = service(provider)
    svc.configure({ provider: 'ollama', fastModel: 'm' }, null)
    await svc.probe()
    const report = svc.report()
    expect(report.setup).toBe('unreachable')
    expect(report.lastError).toBe('connect ENOENT')
    expect(report.status.chat?.ready).toBe(false)
    await svc.probe()
    expect(svc.report().setup).toBeNull()
  })

  it('keeps chat ready for Explain error when only chat is switched off', () => {
    const { svc } = service(fakeProvider(() => '').provider)
    svc.configure({ provider: 'ollama', fastModel: 'm', chat: false }, null)
    const report = svc.report()
    expect(report.status.chat?.ready).toBe(true)
    expect(report.features?.find((f) => f.id === 'chat')?.on).toBe(false)
  })
})

describe('AssistantService requests', () => {
  it('refuses a point whose features are off', async () => {
    const { svc } = service(fakeProvider(() => 'x').provider)
    svc.configure({ provider: 'ollama', fastModel: 'm', chat: false, explainError: false }, null)
    expect((await failureOf(svc.handle('chat', chatInput, ctx()))).code).toBe('unavailable')
  })

  it('streams chat as JSON UI message chunks in order and returns the full reply', async () => {
    const { svc } = service(fakeProvider(() => 'Hello world').provider)
    svc.configure({ provider: 'ollama', fastModel: 'm' }, null)
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

  it('stops sending chunks once the host says nobody listens', async () => {
    const { svc } = service(fakeProvider(() => 'abcdefghi').provider)
    svc.configure({ provider: 'ollama', fastModel: 'm' }, null)
    const chunk = vi.fn(async () => false)
    await svc.handle('chat', chatInput, ctx({ chunk }))
    expect(chunk).toHaveBeenCalledTimes(1)
  })

  it('runs only the input tasks that are on, with the fast model', async () => {
    const { provider, calls } = fakeProvider((system) =>
      system.includes('spelling')
        ? 'fix the tests'
        : '```json\n{"score":"2","notes":["Name the file"]}\n```',
    )
    const { svc } = service(provider)
    svc.configure({ provider: 'ollama', fastModel: 'small', chatModel: 'big' }, null)
    expect(
      await svc.handle('input', { text: 'fix teh tests', tasks: ['typos', 'review'] }, ctx()),
    ).toEqual({ corrected: 'fix the tests', review: { score: 2, notes: ['Name the file'] } })
    expect(calls.map((c) => c.modelId)).toEqual(['small', 'small'])
    svc.configure({ provider: 'ollama', fastModel: 'small', promptReview: false }, null)
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
    svc.configure({ provider: 'ollama', fastModel: 'm' }, null)
    expect(await svc.handle('command', { query: 'x' }, ctx())).toEqual({
      suggestions: [{ command: 'ls -S' }],
    })
    expect(calls).toHaveLength(2)
  })

  it('returns no review when the model answers with something that is not one', async () => {
    const { svc } = service(fakeProvider(() => 'looks fine to me').provider)
    svc.configure({ provider: 'ollama', fastModel: 'm' }, null)
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
    svc.configure({ provider: 'ollama', fastModel: 'm' }, null)
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
    svc.configure({ provider: 'ollama', fastModel: 'm', requestsPerMinute: 1 }, null)
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
    svc.configure({ provider: 'openai', fastModel: 'm' }, 'sk-secret-1')
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
    svc.configure({ provider: 'ollama', fastModel: 'm' }, null)
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
    svc.configure({ provider: 'ollama', fastModel: 'm' }, null)
    const err = await failureOf(
      svc.handle('command', { query: 'x' }, ctx({ signal: abort.signal })),
    )
    expect(err.code).toBe('cancelled')
  })
})

describe('AssistantService panel', () => {
  it('shows the setup problem and skips listing models without a key', async () => {
    const { provider } = fakeProvider(() => '')
    const { svc } = service(provider)
    svc.configure({ provider: 'anthropic', fastModel: 'claude-x' }, null)
    expect(await svc.panelState()).toMatchObject({
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1',
      problem: 'no-key',
      models: [],
    })
    expect(provider.models).not.toHaveBeenCalled()
  })

  it('lists models and features, and refuses lifecycle calls on providers without one', async () => {
    const { svc } = service(fakeProvider(() => '').provider)
    svc.configure({ provider: 'ollama', fastModel: 'm', typos: false }, null)
    const state = await svc.panelState()
    expect(state.models).toEqual([{ id: 'm1' }])
    expect(state.features.find((f) => f.id === 'typos')).toMatchObject({ on: false, ready: false })
    await expect(svc.setLoaded('m1', true)).rejects.toThrow(/no model lifecycle/)
  })
})
