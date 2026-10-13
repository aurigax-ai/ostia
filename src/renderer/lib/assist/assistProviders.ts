import {
  ASSIST_PROVIDERS_MAX,
  ASSIST_PROVIDER_ID_PATTERN,
  ASSIST_PROVIDER_MODELS_MAX,
  type AssistProviderConfig,
  type AssistProviderKind,
  isAssistModelId,
} from '@shared/assist'

export function newProviderId(kind: string, taken: readonly string[]): string {
  if (!taken.includes(kind)) return kind
  for (let n = 2; ; n++) {
    const id = `${kind.slice(0, 28)}-${n}`
    if (!taken.includes(id)) return id
  }
}

export function withProvider(
  providers: readonly AssistProviderConfig[],
  extId: string,
  kind: AssistProviderKind,
): AssistProviderConfig[] | null {
  if (providers.length >= ASSIST_PROVIDERS_MAX) return null
  const id = newProviderId(
    kind.id,
    providers.map((p) => p.id),
  )
  if (!ASSIST_PROVIDER_ID_PATTERN.test(id)) return null
  const name = providers.some((p) => p.name === kind.title) ? `${kind.title} (${id})` : kind.title
  return [...providers, { id, extId, kind: kind.id, name, baseUrl: '', enabled: true, models: [] }]
}

export function patchProvider(
  providers: readonly AssistProviderConfig[],
  id: string,
  patch: Partial<Pick<AssistProviderConfig, 'name' | 'baseUrl' | 'enabled' | 'models'>>,
): AssistProviderConfig[] {
  return providers.map((p) => (p.id === id ? { ...p, ...patch } : p))
}

export function withModel(models: readonly string[], raw: string): string[] | null {
  const id = raw.trim()
  if (!isAssistModelId(id) || models.includes(id)) return null
  if (models.length >= ASSIST_PROVIDER_MODELS_MAX) return null
  return [...models, id]
}
