import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { simulateStreamingMiddleware, wrapLanguageModel } from 'ai'
import type { AssistModel } from '../../shared/assist'
import {
  type Endpoint,
  UNIX_PREFIX,
  baseUrl,
  endpointFetch,
  requestJson,
} from '../sdk/assist/endpoint'
import type { Provider, ProviderCatalog } from '../sdk/assist/provider'

export const MODEL_RUNTIME = 'model-runtime'
const MODELS_TIMEOUT_MS = 15_000
const LIFECYCLE_TIMEOUT_MS = 120_000

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
    name: MODEL_RUNTIME,
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
    kind: MODEL_RUNTIME,
    lifecycle: true,
    serverCancels: false,
    smallPrompts: true,
    chatTools: async () => 'prompted',
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
          const entry: AssistModel = {
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

export const MODEL_RUNTIME_CATALOG: ProviderCatalog = {
  kinds: [MODEL_RUNTIME],
  keyRequired: new Set(),
  defaultBaseUrl: (_kind, env) =>
    env.XDG_RUNTIME_DIR ? `${UNIX_PREFIX}${env.XDG_RUNTIME_DIR}/model-runtime.sock` : '',
  defaultFastModel: () => 'gemma',
  create: (_kind, endpoint) => modelRuntimeProvider(endpoint),
}
