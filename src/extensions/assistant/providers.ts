import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { AssistModel, ChatToolMode } from '../../shared/assist'
import { PRODUCT_NAME } from '../../shared/product'
import {
  type Endpoint,
  type FetchFn,
  baseUrl,
  endpointFetch,
  requestJson,
} from '../sdk/assist/endpoint'
import type { Provider, ProviderCatalog } from '../sdk/assist/provider'
import { createTranslator } from '../sdk/i18n'

export const PROVIDER_KINDS = [
  'ollama',
  'openai-compatible',
  'openrouter',
  'openai',
  'anthropic',
] as const

export type ProviderKind = (typeof PROVIDER_KINDS)[number]

export const ANTHROPIC_VERSION = '2023-06-01'
export const OPENROUTER_HEADERS = { 'X-Title': PRODUCT_NAME }
const MODELS_TIMEOUT_MS = 15_000
const SHOW_TIMEOUT_MS = 5000
const native = async (): Promise<ChatToolMode> => 'native'

interface ListedModel {
  id?: unknown
  name?: unknown
  display_name?: unknown
}

function listed(data: ListedModel[] | undefined, nameKey: 'name' | 'display_name'): AssistModel[] {
  return (data ?? [])
    .filter((m) => typeof m.id === 'string' && m.id)
    .map((m) => {
      const entry: AssistModel = { id: m.id as string }
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
  return async (signal?: AbortSignal, timeoutMs = MODELS_TIMEOUT_MS): Promise<AssistModel[]> => {
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

function ollamaChatTools(fetch: FetchFn, endpoint: Endpoint) {
  const url = `${endpoint.origin}${endpoint.basePath.replace(/\/v1$/, '')}/api/show`
  return async (id: string, signal?: AbortSignal): Promise<ChatToolMode> => {
    try {
      const res = await requestJson<{ capabilities?: unknown }>({
        fetch,
        url,
        method: 'POST',
        body: { model: id },
        signal,
        timeoutMs: SHOW_TIMEOUT_MS,
      })
      return Array.isArray(res.capabilities) && res.capabilities.includes('tools')
        ? 'native'
        : 'prompted'
    } catch {
      return 'prompted'
    }
  }
}

function bearer(apiKey: string | null): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

export function createProvider(
  kind: ProviderKind,
  endpoint: Endpoint,
  apiKey: string | null,
): Provider {
  const fetch = endpointFetch(endpoint)
  const base = baseUrl(endpoint)
  const key = apiKey ?? undefined
  switch (kind) {
    case 'anthropic': {
      const anthropic = createAnthropic({ baseURL: base, apiKey: apiKey ?? '', fetch })
      const headers = { 'x-api-key': apiKey ?? '', 'anthropic-version': ANTHROPIC_VERSION }
      return {
        kind,
        lifecycle: false,
        serverCancels: true,
        smallPrompts: false,
        chatTools: native,
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
        serverCancels: true,
        smallPrompts: false,
        chatTools: native,
        model: (id) => openrouter.chat(id),
        models: listModels(fetch, `${base}/models`, bearer(apiKey), 'name'),
      }
    }
    case 'openai': {
      const openai = createOpenAI({ baseURL: base, apiKey: apiKey ?? '', fetch })
      return {
        kind,
        lifecycle: false,
        serverCancels: true,
        smallPrompts: false,
        chatTools: native,
        model: (id) => openai.chat(id),
        models: listModels(fetch, `${base}/models`, bearer(apiKey), 'name'),
      }
    }
    default: {
      const compat = createOpenAICompatible({ name: kind, baseURL: base, apiKey: key, fetch })
      return {
        kind,
        lifecycle: false,
        serverCancels: true,
        smallPrompts: false,
        chatTools: kind === 'ollama' ? ollamaChatTools(fetch, endpoint) : native,
        model: (id) => compat.chatModel(id),
        models: listModels(fetch, `${base}/models`, bearer(apiKey), 'name'),
      }
    }
  }
}

const DEFAULT_BASE_URLS: Partial<Record<ProviderKind, string>> = {
  ollama: 'http://127.0.0.1:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
}

const KIND_TITLES: Record<ProviderKind, string> = {
  ollama: 'Ollama',
  'openai-compatible': 'OpenAI-compatible',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
}

const translate = createTranslator()

export function kindTitle(kind: string, locale: string): string {
  const key = `kind.${kind}`
  const title = translate(locale)(key)
  return title === key ? (KIND_TITLES[kind as ProviderKind] ?? kind) : title
}

export const ASSISTANT_CATALOG: ProviderCatalog = {
  kinds: PROVIDER_KINDS,
  keyRequired: new Set(['openrouter', 'openai', 'anthropic']),
  title: kindTitle,
  defaultBaseUrl: (kind) => DEFAULT_BASE_URLS[kind as ProviderKind] ?? '',
  create: (kind, endpoint, apiKey) => createProvider(kind as ProviderKind, endpoint, apiKey),
}
