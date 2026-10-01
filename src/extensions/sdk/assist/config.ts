import type {
  AssistFeatureId,
  AssistPoint,
  AssistProviderEntry,
  AssistSetupProblem,
} from '../../../shared/assist'
import type { ExtensionSettingValues } from '../../../shared/extensions'
import { type Endpoint, parseEndpoint } from './endpoint'
import type { ProviderCatalog } from './provider'

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
  entries: AssistProviderEntry[]
  features: Record<Feature, boolean>
  requestsPerMinute: number
}

export const DEFAULT_REQUESTS_PER_MINUTE = 30

export function readConfig(
  values: ExtensionSettingValues,
  entries: readonly AssistProviderEntry[],
  catalog: ProviderCatalog,
): AssistantConfig {
  const rpm = values.requestsPerMinute
  const features = {} as Record<Feature, boolean>
  for (const f of FEATURES) features[f] = values[f] !== false
  return {
    catalog,
    entries: entries.filter((entry) => catalog.kinds.includes(entry.kind)),
    features,
    requestsPerMinute:
      typeof rpm === 'number' && Number.isFinite(rpm)
        ? Math.min(600, Math.max(1, Math.round(rpm)))
        : DEFAULT_REQUESTS_PER_MINUTE,
  }
}

export function endpointOf(
  entry: AssistProviderEntry,
  catalog: ProviderCatalog,
  env: NodeJS.ProcessEnv,
): Endpoint | null {
  return parseEndpoint(entry.baseUrl || catalog.defaultBaseUrl(entry.kind, env))
}

export type EntryProblem = Extract<AssistSetupProblem, 'no-endpoint' | 'no-key'>

export function entryProblem(
  entry: AssistProviderEntry,
  catalog: ProviderCatalog,
  env: NodeJS.ProcessEnv,
): EntryProblem | null {
  if (!endpointOf(entry, catalog, env)) return 'no-endpoint'
  if (catalog.keyRequired.has(entry.kind) && !entry.apiKey) return 'no-key'
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

export function pointOn(config: AssistantConfig, point: AssistPoint): boolean {
  return POINT_FEATURES[point].some((f) => config.features[f])
}
