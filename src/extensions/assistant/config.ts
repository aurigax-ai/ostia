import type {
  AssistFeatureId,
  AssistFeatureState,
  AssistPoint,
  AssistSetupProblem,
  AssistStatus,
  ChatToolMode,
} from '../../shared/assist'
import type { ExtensionSettingValues } from '../../shared/extensions'
import { type Endpoint, UNIX_PREFIX, parseEndpoint } from './endpoint'
import { PROVIDER_KINDS, type ProviderKind } from './providers'

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
  provider: ProviderKind
  baseUrl: string
  fastModel: string
  chatModel: string
  features: Record<Feature, boolean>
  requestsPerMinute: number
}

const KEY_REQUIRED: ReadonlySet<ProviderKind> = new Set(['openrouter', 'openai', 'anthropic'])

export const DEFAULT_REQUESTS_PER_MINUTE = 30

function str(values: ExtensionSettingValues, key: string): string {
  const v = values[key]
  return typeof v === 'string' ? v.trim() : ''
}

export function readConfig(values: ExtensionSettingValues): AssistantConfig {
  const provider = PROVIDER_KINDS.includes(values.provider as ProviderKind)
    ? (values.provider as ProviderKind)
    : 'none'
  const rpm = values.requestsPerMinute
  const features = {} as Record<Feature, boolean>
  for (const f of FEATURES) features[f] = values[f] !== false
  return {
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

export function defaultBaseUrl(provider: ProviderKind, env: NodeJS.ProcessEnv): string {
  switch (provider) {
    case 'model-runtime':
      return env.XDG_RUNTIME_DIR ? `${UNIX_PREFIX}${env.XDG_RUNTIME_DIR}/model-runtime.sock` : ''
    case 'ollama':
      return 'http://127.0.0.1:11434/v1'
    case 'openrouter':
      return 'https://openrouter.ai/api/v1'
    case 'openai':
      return 'https://api.openai.com/v1'
    case 'anthropic':
      return 'https://api.anthropic.com/v1'
    default:
      return ''
  }
}

export function endpointOf(config: AssistantConfig, env: NodeJS.ProcessEnv): Endpoint | null {
  if (config.provider === 'none') return null
  return parseEndpoint(config.baseUrl || defaultBaseUrl(config.provider, env))
}

export function fastModelOf(config: AssistantConfig): string {
  if (config.fastModel) return config.fastModel
  return config.provider === 'model-runtime' ? 'gemma' : ''
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
  if (config.provider === 'none') return 'no-provider'
  if (!endpointOf(config, env)) return 'no-endpoint'
  if (KEY_REQUIRED.has(config.provider) && !hasKey) return 'no-key'
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
  if (config.provider === 'none') return undefined
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
