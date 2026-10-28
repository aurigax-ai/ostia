import {
  AGENT_PROVIDER_MODELS_MAX,
  type AgentProviderEntry,
} from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { AGENT_ACT_TOOLS, type AgentActTool } from './agentCoreTools'

const AGENT_PROVIDERS_MAX = 16
const AGENT_PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const AGENT_PROVIDER_NAME_MAX = 80
const AGENT_MODEL_MAX = 120
const AGENT_URL_MAX = 2048

export interface AgentHostSettings {
  providers: AgentProviderEntry[]
  alwaysAsk: AgentActTool[]
}

export const DEFAULT_AGENT_SETTINGS: AgentHostSettings = {
  providers: [],
  alwaysAsk: [...AGENT_ACT_TOOLS],
}

function parseAlwaysAsk(raw: unknown): AgentActTool[] {
  if (!Array.isArray(raw)) return [...AGENT_ACT_TOOLS]
  const listed = new Set(raw.filter((name): name is string => typeof name === 'string'))
  return AGENT_ACT_TOOLS.filter((name) => listed.has(name))
}

function plainHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > AGENT_URL_MAX) return null
  try {
    const url = new URL(value)
    const web = url.protocol === 'http:' || url.protocol === 'https:'
    return web && !url.username && !url.password && !url.search && !url.hash ? value : null
  } catch {
    return null
  }
}

function modelIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const ids = raw.filter(
    (m): m is string => typeof m === 'string' && m.length > 0 && m.length <= AGENT_MODEL_MAX,
  )
  return [...new Set(ids)].slice(0, AGENT_PROVIDER_MODELS_MAX)
}

function parseAgentProvider(raw: unknown): AgentProviderEntry | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !AGENT_PROVIDER_ID.test(raw.id)) return null
  const baseUrl = plainHttpUrl(raw.baseUrl)
  const models = modelIds(raw.models)
  if (!baseUrl || models.length === 0) return null
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, AGENT_PROVIDER_NAME_MAX) : ''
  return { id: raw.id, name: name || raw.id, baseUrl, models }
}

export function parseAgentSettings(raw: unknown): AgentHostSettings {
  const src = isRecord(raw) ? raw : {}
  const providers: AgentProviderEntry[] = []
  for (const item of Array.isArray(src.providers) ? src.providers : []) {
    if (providers.length === AGENT_PROVIDERS_MAX) break
    const provider = parseAgentProvider(item)
    if (provider && !providers.some((p) => p.id === provider.id)) providers.push(provider)
  }
  return { providers, alwaysAsk: parseAlwaysAsk(src.alwaysAsk) }
}
