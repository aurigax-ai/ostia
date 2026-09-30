import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { type LanguageModel, simulateStreamingMiddleware, wrapLanguageModel } from 'ai'
import { PRODUCT_NAME } from '../../shared/product'
import { type Endpoint, type FetchFn, baseUrl, endpointFetch, requestJson } from './endpoint'
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

export interface Provider {
  kind: ProviderKind
  lifecycle: boolean
  model: (id: string) => Exclude<LanguageModel, string>
  models: (signal?: AbortSignal, timeoutMs?: number) => Promise<ModelEntry[]>
  load?: (id: string) => Promise<void>
  unload?: (id: string) => Promise<void>
}

export const ANTHROPIC_VERSION = '2023-06-01'
export const OPENROUTER_HEADERS = { 'X-Title': PRODUCT_NAME }
const MODELS_TIMEOUT_MS = 15_000
const LIFECYCLE_TIMEOUT_MS = 120_000

interface ListedModel {
  id?: unknown
  name?: unknown
  display_name?: unknown
}

function listed(data: ListedModel[] | undefined, nameKey: 'name' | 'display_name'): ModelEntry[] {
  return (data ?? [])
    .filter((m) => typeof m.id === 'string' && m.id)
    .map((m) => {
      const entry: ModelEntry = { id: m.id as string }
      const name = m[nameKey]
      if (typeof name === 'string' && name && name !== m.id) entry.name = name
      return entry
    })
}

function listModels(
  fetch: FetchFn,
  url: string,
  headers: Record<string, string>,
  nameKey: 'name' | 'display_name',
) {
  return async (signal?: AbortSignal, timeoutMs = MODELS_TIMEOUT_MS): Promise<ModelEntry[]> => {
    const res = await requestJson<{ data?: ListedModel[] }>({
      fetch,
      url,
      headers,
      signal,
      timeoutMs,
    })
    return listed(res.data, nameKey)
  }
}

function bearer(apiKey: string | null): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
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
  const fetch = endpointFetch(endpoint)
  const compat = createOpenAICompatible({
    name: 'model-runtime',
    baseURL: baseUrl(endpoint, '/v1'),
    fetch,
  })
  const post = async (id: string, action: 'load' | 'unload'): Promise<void> => {
    await requestJson({
      fetch,
      url: baseUrl(endpoint, `/models/${encodeURIComponent(id)}/${action}`),
      method: 'POST',
      timeoutMs: LIFECYCLE_TIMEOUT_MS,
    })
  }
  return {
    kind: 'model-runtime',
    lifecycle: true,
    model: (id) =>
      wrapLanguageModel({ model: compat.chatModel(id), middleware: simulateStreamingMiddleware() }),
    models: async (signal, timeoutMs = MODELS_TIMEOUT_MS) => {
      const res = await requestJson<{ models?: RuntimeModel[] }>({
        fetch,
        url: baseUrl(endpoint, '/models'),
        signal,
        timeoutMs,
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

export function createProvider(
  kind: Exclude<ProviderKind, 'none'>,
  endpoint: Endpoint,
  apiKey: string | null,
): Provider {
  const fetch = endpointFetch(endpoint)
  const base = baseUrl(endpoint)
  const key = apiKey ?? undefined
  switch (kind) {
    case 'model-runtime':
      return modelRuntimeProvider(endpoint)
    case 'anthropic': {
      const anthropic = createAnthropic({ baseURL: base, apiKey: apiKey ?? '', fetch })
      const headers = { 'x-api-key': apiKey ?? '', 'anthropic-version': ANTHROPIC_VERSION }
      return {
        kind,
        lifecycle: false,
        model: (id) => anthropic(id),
        models: listModels(fetch, `${base}/models`, headers, 'display_name'),
      }
    }
    case 'openrouter': {
      const openrouter = createOpenRouter({
        baseURL: base,
        apiKey: key,
        headers: OPENROUTER_HEADERS,
        fetch,
      })
      return {
        kind,
        lifecycle: false,
        model: (id) => openrouter.chat(id),
        models: listModels(fetch, `${base}/models`, bearer(apiKey), 'name'),
      }
    }
    case 'openai': {
      const openai = createOpenAI({ baseURL: base, apiKey: apiKey ?? '', fetch })
      return {
        kind,
        lifecycle: false,
        model: (id) => openai.chat(id),
        models: listModels(fetch, `${base}/models`, bearer(apiKey), 'name'),
      }
    }
    default: {
      const compat = createOpenAICompatible({ name: kind, baseURL: base, apiKey: key, fetch })
      return {
        kind,
        lifecycle: false,
        model: (id) => compat.chatModel(id),
        models: listModels(fetch, `${base}/models`, bearer(apiKey), 'name'),
      }
    }
  }
}
