import type { LanguageModel } from 'ai'
import type { AssistModel, ChatToolMode } from '../../../shared/assist'
import type { Endpoint } from './endpoint'

export interface Provider {
  kind: string
  lifecycle: boolean
  serverCancels: boolean
  smallPrompts: boolean
  chatTools: (id: string, signal?: AbortSignal) => Promise<ChatToolMode>
  model: (id: string) => Exclude<LanguageModel, string>
  models: (signal?: AbortSignal, timeoutMs?: number) => Promise<AssistModel[]>
  load?: (id: string) => Promise<void>
  unload?: (id: string) => Promise<void>
}

export interface ProviderCatalog {
  kinds: readonly string[]
  keyRequired: ReadonlySet<string>
  defaultBaseUrl: (kind: string, env: NodeJS.ProcessEnv) => string
  defaultFastModel: (kind: string) => string
  create: (kind: string, endpoint: Endpoint, apiKey: string | null) => Provider
}

export const NO_PROVIDER = 'none'
