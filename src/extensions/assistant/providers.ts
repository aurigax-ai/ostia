import { PRODUCT_NAME } from '../../shared/product'
import { type Endpoint, fetchJson, streamSse } from './http'
import type { ModelEntry } from './models'

export const PROVIDER_KINDS = [
  'none',
  'model-runtime',
  'ollama',
  'openai-compatible',
  'openrouter',
  'openai',
  'anthropic',
] as const

export type ProviderKind = (typeof PROVIDER_KINDS)[number]

export interface PromptMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatParams {
  model: string
  system?: string
  messages: PromptMessage[]
  temperature: number
  maxTokens: number
  signal?: AbortSignal
  timeoutMs?: number
  onDelta?: (text: string) => void
}

export interface Provider {
  kind: ProviderKind
  lifecycle: boolean
  chat: (params: ChatParams) => Promise<string>
  models: (signal?: AbortSignal) => Promise<ModelEntry[]>
  load?: (id: string) => Promise<void>
  unload?: (id: string) => Promise<void>
}

export interface OpenAiOptions {
  kind: ProviderKind
  endpoint: Endpoint
  apiKey?: string
  headers?: Record<string, string>
  stream: boolean
  chatPath: string
  modelsPath: string
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OpenAiReply {
  choices?: { message?: { content?: unknown }; delta?: { content?: unknown } }[]
}

const MODELS_TIMEOUT_MS = 15_000

function openAiMessages(params: ChatParams): OpenAiMessage[] {
  const messages: OpenAiMessage[] = params.system
    ? [{ role: 'system', content: params.system }]
    : []
  return [...messages, ...params.messages]
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function openAiDelta(data: string): string | null {
  if (data.trim() === '[DONE]') return null
  const parsed = JSON.parse(data) as OpenAiReply & { error?: { message?: unknown } }
  if (parsed.error) throw new Error(textOf(parsed.error.message) || 'provider error')
  return textOf(parsed.choices?.[0]?.delta?.content)
}

export function openAiProvider(opts: OpenAiOptions): Provider {
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`
  return {
    kind: opts.kind,
    lifecycle: false,
    chat: async (params) => {
      const body = {
        model: params.model,
        messages: openAiMessages(params),
        temperature: params.temperature,
        max_tokens: params.maxTokens,
      }
      const http = {
        method: 'POST' as const,
        headers,
        signal: params.signal,
        timeoutMs: params.timeoutMs,
      }
      if (!opts.stream || !params.onDelta) {
        const reply = await fetchJson<OpenAiReply>(opts.endpoint, opts.chatPath, {
          ...http,
          body: { ...body, stream: false },
        })
        const text = textOf(reply.choices?.[0]?.message?.content)
        if (text) params.onDelta?.(text)
        return text
      }
      let text = ''
      await streamSse(
        opts.endpoint,
        opts.chatPath,
        { ...http, body: { ...body, stream: true } },
        (event) => {
          const delta = openAiDelta(event.data)
          if (!delta) return
          text += delta
          params.onDelta?.(delta)
        },
      )
      return text
    },
    models: async (signal) => {
      const res = await fetchJson<{ data?: { id?: unknown; name?: unknown }[] }>(
        opts.endpoint,
        opts.modelsPath,
        { headers, signal, timeoutMs: MODELS_TIMEOUT_MS },
      )
      return (res.data ?? [])
        .filter((m) => typeof m.id === 'string' && m.id)
        .map((m) => {
          const entry: ModelEntry = { id: m.id as string }
          if (typeof m.name === 'string' && m.name && m.name !== m.id) entry.name = m.name
          return entry
        })
    },
  }
}

interface RuntimeModel {
  id?: unknown
  description?: unknown
  installed?: unknown
  loaded?: unknown
  busy?: unknown
  idle_secs?: unknown
}

export function modelRuntimeProvider(endpoint: Endpoint): Provider {
  const base = openAiProvider({
    kind: 'model-runtime',
    endpoint,
    stream: false,
    chatPath: '/v1/chat/completions',
    modelsPath: '/models',
  })
  const post = async (id: string, action: 'load' | 'unload'): Promise<void> => {
    await fetchJson(endpoint, `/models/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      timeoutMs: 120_000,
    })
  }
  return {
    ...base,
    lifecycle: true,
    models: async (signal) => {
      const res = await fetchJson<{ models?: RuntimeModel[] }>(endpoint, '/models', {
        signal,
        timeoutMs: MODELS_TIMEOUT_MS,
      })
      return (res.models ?? [])
        .filter((m) => typeof m.id === 'string' && m.id)
        .map((m) => {
          const entry: ModelEntry = {
            id: m.id as string,
            installed: m.installed === true,
            loaded: m.loaded === true,
            busy: m.busy === true,
          }
          if (typeof m.description === 'string') entry.description = m.description
          if (typeof m.idle_secs === 'number') entry.idleSecs = m.idle_secs
          return entry
        })
    },
    load: (id) => post(id, 'load'),
    unload: (id) => post(id, 'unload'),
  }
}

export const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicEvent {
  type?: unknown
  delta?: { type?: unknown; text?: unknown }
  error?: { message?: unknown }
}

export function anthropicDelta(data: string): string {
  const parsed = JSON.parse(data) as AnthropicEvent
  if (parsed.type === 'error') throw new Error(textOf(parsed.error?.message) || 'provider error')
  if (parsed.type !== 'content_block_delta') return ''
  return parsed.delta?.type === 'text_delta' ? textOf(parsed.delta.text) : ''
}

export function anthropicProvider(endpoint: Endpoint, apiKey: string): Provider {
  const headers = { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
  return {
    kind: 'anthropic',
    lifecycle: false,
    chat: async (params) => {
      const body: Record<string, unknown> = {
        model: params.model,
        messages: params.messages,
        max_tokens: params.maxTokens,
        temperature: params.temperature,
      }
      if (params.system) body.system = params.system
      const http = {
        method: 'POST' as const,
        headers,
        signal: params.signal,
        timeoutMs: params.timeoutMs,
      }
      if (!params.onDelta) {
        const reply = await fetchJson<{ content?: { type?: unknown; text?: unknown }[] }>(
          endpoint,
          '/messages',
          { ...http, body },
        )
        return (reply.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => textOf(c.text))
          .join('')
      }
      let text = ''
      await streamSse(
        endpoint,
        '/messages',
        { ...http, body: { ...body, stream: true } },
        (event) => {
          const delta = anthropicDelta(event.data)
          if (!delta) return
          text += delta
          params.onDelta?.(delta)
        },
      )
      return text
    },
    models: async (signal) => {
      const res = await fetchJson<{ data?: { id?: unknown; display_name?: unknown }[] }>(
        endpoint,
        '/models',
        { headers, signal, timeoutMs: MODELS_TIMEOUT_MS },
      )
      return (res.data ?? [])
        .filter((m) => typeof m.id === 'string' && m.id)
        .map((m) => {
          const entry: ModelEntry = { id: m.id as string }
          if (typeof m.display_name === 'string') entry.name = m.display_name
          return entry
        })
    },
  }
}

export const OPENROUTER_HEADERS = { 'X-Title': PRODUCT_NAME }

export function createProvider(
  kind: Exclude<ProviderKind, 'none'>,
  endpoint: Endpoint,
  apiKey: string | null,
): Provider {
  const key = apiKey ?? undefined
  switch (kind) {
    case 'model-runtime':
      return modelRuntimeProvider(endpoint)
    case 'anthropic':
      return anthropicProvider(endpoint, apiKey ?? '')
    case 'openrouter':
      return openAiProvider({
        kind,
        endpoint,
        apiKey: key,
        headers: OPENROUTER_HEADERS,
        stream: true,
        chatPath: '/chat/completions',
        modelsPath: '/models',
      })
    default:
      return openAiProvider({
        kind,
        endpoint,
        apiKey: key,
        stream: true,
        chatPath: '/chat/completions',
        modelsPath: '/models',
      })
  }
}
