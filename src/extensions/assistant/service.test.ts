import { describe, expect, it, vi } from 'vitest'
import { type AssistContext, AssistFailure } from '../sdk'
import { HttpError } from './http'
import type { ChatParams, Provider } from './providers'
import { AssistantService } from './service'

const ENV = { XDG_RUNTIME_DIR: '/run/user/1000' }

function fakeProvider(reply: (p: ChatParams) => string | Promise<string>): Provider {
  return {
    kind: 'openai-compatible',
    lifecycle: false,
    chat: vi.fn(async (p: ChatParams) => {
      const text = await reply(p)
      for (const part of text.match(/.{1,3}/gs) ?? []) p.onDelta?.(part)
      return text
    }),
    models: async () => [{ id: 'm1' }],
  }
}

function ctx(overrides: Partial<AssistContext> = {}): AssistContext {
  return {
    requestId: 'r1',
    signal: new AbortController().signal,
    chunk: async () => true,
    ...overrides,
  }
}

function service(provider: Provider, now: () => number = () => 0) {
  const factory = vi.fn(() => provider)
  return { svc: new AssistantService(ENV, factory, now), factory }
}

async function failureOf(p: Promise<unknown>): Promise<AssistFailure> {
  const err = await p.catch((e) => e)
  expect(err).toBeInstanceOf(AssistFailure)
  return err as AssistFailure
}

describe('AssistantService status', () => {
  it('is not ready anywhere until a provider is picked', () => {
    const { svc, factory } = service(fakeProvider(() => ''))
    svc.configure({ provider: 'none', fastModel: 'x' }, null)
    expect(svc.status()).toEqual({
      input: { ready: false },
      command: { ready: false },
      completion: { ready: false },
      chat: { ready: false },
    })
    expect(factory).not.toHaveBeenCalled()
  })

  it('labels each point with provider and model, gemma by default on model-runtime', () => {
    const { svc, factory } = service(fakeProvider(() => ''))
    svc.configure({ provider: 'model-runtime', chatModel: 'big', editorCompletions: false }, null)
    expect(svc.status()).toEqual({
      input: { ready: true, label: 'model-runtime · gemma' },
      command: { ready: true, label: 'model-runtime · gemma' },
      completion: { ready: false },
      chat: { ready: true, label: 'model-runtime · big' },
    })
    expect(factory).toHaveBeenCalledWith(
      'model-runtime',
      { socketPath: '/run/user/1000/model-runtime.sock', basePath: '', secure: false },
      null,
    )
  })

  it('needs a key for hosted providers and a base URL for openai-compatible', () => {
    const { svc } = service(fakeProvider(() => ''))
    svc.configure({ provider: 'openrouter', fastModel: 'a/b' }, null)
    expect(svc.status().chat).toEqual({ ready: false })
    svc.configure({ provider: 'openrouter', fastModel: 'a/b' }, '  ')
    expect(svc.status().chat).toEqual({ ready: false })
    svc.configure({ provider: 'openrouter', fastModel: 'a/b' }, 'sk')
    expect(svc.status().chat).toEqual({ ready: true, label: 'openrouter · a/b' })
    svc.configure({ provider: 'openai-compatible', fastModel: 'm' }, null)
    expect(svc.status().chat).toEqual({ ready: false })
    svc.configure({ provider: 'openai-compatible', fastModel: 'm', baseUrl: 'http://h:1/v1' }, null)
    expect(svc.status().chat?.ready).toBe(true)
  })
})

describe('AssistantService requests', () => {
  it('refuses a point whose feature is off', async () => {
    const { svc } = service(fakeProvider(() => 'x'))
    svc.configure({ provider: 'ollama', fastModel: 'm', chat: false }, null)
    const err = await failureOf(
      svc.handle('chat', { messages: [{ role: 'user', content: 'hi' }], context: [] }, ctx()),
    )
    expect(err.code).toBe('unavailable')
  })

  it('streams chat deltas in order through ctx.chunk and returns the full reply', async () => {
    const { svc } = service(fakeProvider(() => 'Hello world'))
    svc.configure({ provider: 'ollama', fastModel: 'm' }, null)
    const chunks: string[] = []
    const res = await svc.handle(
      'chat',
      { messages: [{ role: 'user', content: 'hi' }], context: [] },
      ctx({
        chunk: async (t) => {
          await new Promise((r) => setTimeout(r, 1))
          chunks.push(t)
          return true
        },
      }),
    )
    expect(res).toEqual({ text: 'Hello world' })
    expect(chunks.join('')).toBe('Hello world')
  })

  it('stops sending chunks once the host says nobody listens', async () => {
    const { svc } = service(fakeProvider(() => 'abcdefghi'))
    svc.configure({ provider: 'ollama', fastModel: 'm' }, null)
    const chunk = vi.fn(async () => false)
    await svc.handle(
      'chat',
      { messages: [{ role: 'user', content: 'hi' }], context: [] },
      ctx({ chunk }),
    )
    expect(chunk).toHaveBeenCalledTimes(1)
  })

  it('runs only the input tasks that are on, with the fast model', async () => {
    const provider = fakeProvider((p) =>
      p.system?.includes('spelling') ? 'fix the tests' : '{"score":2,"notes":["Name the file"]}',
    )
    const { svc } = service(provider)
    svc.configure({ provider: 'ollama', fastModel: 'small', chatModel: 'big' }, null)
    expect(
      await svc.handle('input', { text: 'fix teh tests', tasks: ['typos', 'review'] }, ctx()),
    ).toEqual({ corrected: 'fix the tests', review: { score: 2, notes: ['Name the file'] } })
    expect(vi.mocked(provider.chat).mock.calls.every(([p]) => p.model === 'small')).toBe(true)
    svc.configure({ provider: 'ollama', fastModel: 'small', promptReview: false }, null)
    vi.mocked(provider.chat).mockClear()
    expect(
      await svc
        .handle('input', { text: 'fix teh tests', tasks: ['review'] }, ctx())
        .catch((e) => e.code),
    ).toBe('unavailable')
    expect(provider.chat).not.toHaveBeenCalled()
  })

  it('returns command suggestions and cleaned completions', async () => {
    const { svc } = service(
      fakeProvider((p) =>
        p.system?.includes('shell commands')
          ? '{"suggestions":[{"command":"ls -S","description":"by size"}]}'
          : '```\n42;\n```',
      ),
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
  })

  it('rate-limits each point to requestsPerMinute', async () => {
    let now = 0
    const { svc } = service(
      fakeProvider(() => 'ok'),
      () => now,
    )
    svc.configure({ provider: 'ollama', fastModel: 'm', requestsPerMinute: 1 }, null)
    const ask = () => svc.handle('command', { query: 'x' }, ctx())
    await ask()
    expect((await failureOf(ask())).code).toBe('rate-limited')
    await svc.handle('completion', { path: '/a', language: 'x', prefix: '', suffix: '' }, ctx())
    now = 60_000
    await expect(ask()).resolves.toEqual({ suggestions: [] })
  })

  it('maps provider errors to failures without the API key', async () => {
    const { svc } = service(
      fakeProvider(() => {
        throw new HttpError(401, 'HTTP 401: bad key sk-secret-1')
      }),
    )
    svc.configure({ provider: 'openai', fastModel: 'm' }, 'sk-secret-1')
    const err = await failureOf(svc.handle('command', { query: 'x' }, ctx()))
    expect(err.code).toBe('failed')
    expect(err.message).toBe('HTTP 401: bad key ***')
  })

  it('reports cancelled when the request was aborted', async () => {
    const abort = new AbortController()
    const { svc } = service(
      fakeProvider(() => {
        abort.abort()
        throw new Error('socket hang up')
      }),
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
    const provider = fakeProvider(() => '')
    const models = vi.spyOn(provider, 'models')
    const { svc } = service(provider)
    svc.configure({ provider: 'anthropic', fastModel: 'claude-x' }, null)
    expect(await svc.panelState()).toMatchObject({
      provider: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1',
      problem: 'no-key',
      models: [],
    })
    expect(models).not.toHaveBeenCalled()
  })

  it('lists models and refuses lifecycle calls on providers without one', async () => {
    const { svc } = service(fakeProvider(() => ''))
    svc.configure({ provider: 'ollama', fastModel: 'm' }, null)
    expect((await svc.panelState()).models).toEqual([{ id: 'm1' }])
    await expect(svc.setLoaded('m1', true)).rejects.toThrow(/no model lifecycle/)
  })
})
