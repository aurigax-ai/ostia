import type {
  AssistFeatureId,
  AssistFeatureState,
  AssistPoint,
  AssistSetupProblem,
  AssistStatus,
  ChatToolMode,
} from '../../../shared/assist'
import type { ExtensionSettingValues } from '../../../shared/extensions'
import { type Endpoint, parseEndpoint } from './endpoint'
import { NO_PROVIDER, type ProviderCatalog } from './provider'

export type Feature = AssistFeatureId

export const FEATURES: Feature[] = [
  'chat',
  'typos',
  'promptReview',
  'commandSuggest',
  'terminalCompletions',
  'editorCompletions',
  'explainError',
]

export interface AssistantConfig {
  catalog: ProviderCatalog
  provider: string
  baseUrl: string
  fastModel: string
  chatModel: string
  features: Record<Feature, boolean>
  requestsPerMinute: number
}

export const DEFAULT_REQUESTS_PER_MINUTE = 30

function str(values: ExtensionSettingValues, key: string): string {
  const v = values[key]
  return typeof v === 'string' ? v.trim() : ''
}

export function readConfig(
  values: ExtensionSettingValues,
  catalog: ProviderCatalog,
): AssistantConfig {
  const provider =
    typeof values.provider === 'string' && catalog.kinds.includes(values.provider)
      ? values.provider
      : NO_PROVIDER
  const rpm = values.requestsPerMinute
  const features = {} as Record<Feature, boolean>
  for (const f of FEATURES) features[f] = values[f] !== false
  return {
    catalog,
    provider,
    baseUrl: str(values, 'baseUrl'),
    fastModel: str(values, 'fastModel'),
    chatModel: str(values, 'chatModel'),
    features,
    requestsPerMinute:
      typeof rpm === 'number' && Number.isFinite(rpm)
        ? Math.min(600, Math.max(1, Math.round(rpm)))
        : DEFAULT_REQUESTS_PER_MINUTE,
  }
}

export function endpointOf(config: AssistantConfig, env: NodeJS.ProcessEnv): Endpoint | null {
  if (config.provider === NO_PROVIDER) return null
  return parseEndpoint(config.baseUrl || config.catalog.defaultBaseUrl(config.provider, env))
}

export function fastModelOf(config: AssistantConfig): string {
  if (config.fastModel) return config.fastModel
  return config.catalog.defaultFastModel(config.provider)
}

export function chatModelOf(config: AssistantConfig): string {
  return config.chatModel || fastModelOf(config)
}

export type SetupProblem = Exclude<AssistSetupProblem, 'unreachable'>

export function setupProblem(
  config: AssistantConfig,
  env: NodeJS.ProcessEnv,
  hasKey: boolean,
): SetupProblem | null {
  if (config.provider === NO_PROVIDER) return 'no-provider'
  if (!endpointOf(config, env)) return 'no-endpoint'
  if (config.catalog.keyRequired.has(config.provider) && !hasKey) return 'no-key'
  if (!fastModelOf(config) && !chatModelOf(config)) return 'no-model'
  return null
}

export const POINT_FEATURES: Record<AssistPoint, Feature[]> = {
  input: ['typos', 'promptReview'],
  command: ['commandSuggest'],
  completion: ['editorCompletions'],
  terminal: ['terminalCompletions'],
  chat: ['chat', 'explainError'],
}

export function pointOf(feature: Feature): AssistPoint {
  const entry = (Object.entries(POINT_FEATURES) as [AssistPoint, Feature[]][]).find(([, list]) =>
    list.includes(feature),
  )
  return entry ? entry[0] : 'chat'
}

export function statusLabel(config: AssistantConfig): string | undefined {
  if (config.provider === NO_PROVIDER) return undefined
  const fast = fastModelOf(config)
  const chat = chatModelOf(config)
  const models = chat && chat !== fast ? `${fast} / ${chat}` : fast
  return models ? `${config.provider} · ${models}` : config.provider
}

export function featureStates(
  config: AssistantConfig,
  problem: AssistSetupProblem | null,
): Omit<AssistFeatureState, 'on'>[] {
  return FEATURES.map((id) => ({
    id,
    setting: id,
    ready: problem === null && config.features[id] && modelFor(config, pointOf(id)) !== '',
  }))
}

export function modelFor(config: AssistantConfig, point: AssistPoint): string {
  return point === 'chat' ? chatModelOf(config) : fastModelOf(config)
}

export function assistStatus(
  config: AssistantConfig,
  problem: AssistSetupProblem | null,
  tools: ChatToolMode | null,
): AssistStatus {
  const status: AssistStatus = {}
  for (const point of Object.keys(POINT_FEATURES) as AssistPoint[]) {
    const model = modelFor(config, point)
    const on = POINT_FEATURES[point].some((f) => config.features[f])
    const ready = problem === null && on && model !== ''
    const label = `${config.provider} · ${model}`
    if (!ready) status[point] = { ready: false }
    else if (point === 'chat' && tools) status[point] = { ready, label, tools }
    else status[point] = { ready, label }
  }
  return status
}
