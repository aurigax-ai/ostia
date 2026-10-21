import {
  ASSIST_ERROR_MAX,
  ASSIST_FEATURES,
  ASSIST_KINDS_MAX,
  ASSIST_LABEL_MAX,
  ASSIST_MODEL_DESCRIPTION_MAX,
  ASSIST_MODEL_ID_MAX,
  ASSIST_MODELS_MAX,
  ASSIST_POINTS,
  ASSIST_PROVIDER_ID_PATTERN,
  ASSIST_PROVIDER_MODELS_MAX,
  ASSIST_PROVIDER_NAME_MAX,
  ASSIST_PROVIDER_URL_MAX,
  ASSIST_PROVIDERS_MAX,
  ASSIST_SETUP_PROBLEMS,
  type AssistCatalogModel,
  type AssistFeatureId,
  type AssistModel,
  type AssistModelList,
  type AssistModelRef,
  type AssistModelSettings,
  type AssistPointStatus,
  type AssistProviderConfig,
  type AssistProviderKind,
  type AssistProviderState,
  type AssistSetupProblem,
  type AssistStatus,
  isChatToolMode,
} from './assist'
import { optionalShort } from './assistPayloads'
import { isRecord } from './isRecord'

export function normalizeAssistStatus(raw: unknown): AssistStatus {
  const out: AssistStatus = {}
  if (!isRecord(raw)) return out
  for (const point of ASSIST_POINTS) {
    const entry = raw[point]
    if (!isRecord(entry)) continue
    const status: AssistPointStatus = { ready: entry.ready === true }
    const label = optionalShort(entry.label, ASSIST_LABEL_MAX)
    if (label) status.label = label
    if (point === 'chat' && isChatToolMode(entry.tools)) status.tools = entry.tools
    out[point] = status
  }
  return out
}

export function normalizeAssistFeatures(
  raw: unknown,
): { id: AssistFeatureId; setting: string; ready: boolean }[] {
  const out: { id: AssistFeatureId; setting: string; ready: boolean }[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isRecord(item) || !ASSIST_FEATURES.includes(item.id as AssistFeatureId)) continue
    if (typeof item.setting !== 'string' || out.some((f) => f.id === item.id)) continue
    out.push({ id: item.id as AssistFeatureId, setting: item.setting, ready: item.ready === true })
  }
  return out
}

export function normalizeSetupProblem(raw: unknown): AssistSetupProblem | null {
  return ASSIST_SETUP_PROBLEMS.includes(raw as AssistSetupProblem)
    ? (raw as AssistSetupProblem)
    : null
}

export function normalizeAssistError(raw: unknown): string | undefined {
  return optionalShort(raw, ASSIST_ERROR_MAX)
}

export function normalizeAssistLabel(raw: unknown): string | undefined {
  return optionalShort(raw, ASSIST_LABEL_MAX)
}

function providerId(v: unknown): string | null {
  return typeof v === 'string' && ASSIST_PROVIDER_ID_PATTERN.test(v) ? v : null
}

function modelIds(raw: unknown): string[] {
  const out: string[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const id = typeof item === 'string' ? item.trim() : ''
    if (isAssistModelId(id) && !out.includes(id)) out.push(id)
    if (out.length === ASSIST_PROVIDER_MODELS_MAX) break
  }
  return out
}

export function normalizeModelRef(raw: unknown): AssistModelRef | null {
  if (!isRecord(raw)) return null
  const extId = optionalShort(raw.extId, 64)
  if (!extId) return null
  const provider = providerId(raw.provider)
  if (!provider || !isAssistModelId(raw.model)) return { extId }
  return { extId, provider, model: raw.model }
}

export function normalizeProviderConfig(raw: unknown): AssistProviderConfig | null {
  if (!isRecord(raw)) return null
  const id = providerId(raw.id)
  const kind = providerId(raw.kind)
  const extId = optionalShort(raw.extId, 64)
  if (!id || !kind || !extId) return null
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : ''
  if (baseUrl.length > ASSIST_PROVIDER_URL_MAX) return null
  return {
    id,
    extId,
    kind,
    name: optionalShort(raw.name, ASSIST_PROVIDER_NAME_MAX) ?? kind,
    baseUrl,
    enabled: raw.enabled !== false,
    models: modelIds(raw.models),
  }
}

export function parseAssistModelSettings(raw: unknown): AssistModelSettings {
  const src = isRecord(raw) ? raw : {}
  const providers: AssistProviderConfig[] = []
  for (const item of Array.isArray(src.providers) ? src.providers : []) {
    if (providers.length === ASSIST_PROVIDERS_MAX) break
    const provider = normalizeProviderConfig(item)
    if (provider && !providers.some((p) => p.id === provider.id)) providers.push(provider)
  }
  return {
    providers,
    fastModel: normalizeModelRef(src.fastModel),
    chatModel: normalizeModelRef(src.chatModel),
  }
}

export function normalizeProviderKinds(raw: unknown): AssistProviderKind[] {
  const out: AssistProviderKind[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length === ASSIST_KINDS_MAX) break
    if (!isRecord(item)) continue
    const id = providerId(item.id)
    if (!id || out.some((k) => k.id === id)) continue
    out.push({
      id,
      title: optionalShort(item.title, ASSIST_PROVIDER_NAME_MAX) ?? id,
      baseUrl: optionalShort(item.baseUrl, ASSIST_PROVIDER_URL_MAX) ?? '',
      key: item.key === 'required' ? 'required' : 'optional',
    })
  }
  return out
}

export function normalizeProviderStates(raw: unknown): AssistProviderState[] {
  const out: AssistProviderState[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length === ASSIST_PROVIDERS_MAX) break
    if (!isRecord(item)) continue
    const id = providerId(item.id)
    const kind = providerId(item.kind)
    if (!id || !kind || out.some((p) => p.id === id)) continue
    const models: AssistCatalogModel[] = []
    for (const entry of Array.isArray(item.models) ? item.models : []) {
      if (models.length === ASSIST_MODELS_MAX) break
      if (!isRecord(entry) || !isAssistModelId(entry.id)) continue
      if (models.some((m) => m.id === entry.id)) continue
      models.push(
        isChatToolMode(entry.tools) ? { id: entry.id, tools: entry.tools } : { id: entry.id },
      )
    }
    const state: AssistProviderState = {
      id,
      kind,
      name: optionalShort(item.name, ASSIST_PROVIDER_NAME_MAX) ?? id,
      setup: normalizeSetupProblem(item.setup),
      lifecycle: item.lifecycle === true,
      models,
    }
    const lastError = normalizeAssistError(item.lastError)
    if (lastError) state.lastError = lastError
    out.push(state)
  }
  return out
}

export function isAssistModelId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= ASSIST_MODEL_ID_MAX
}

function assistModel(raw: unknown): AssistModel | null {
  if (!isRecord(raw) || !isAssistModelId(raw.id)) return null
  const model: AssistModel = { id: raw.id }
  const name = optionalShort(raw.name)
  if (name) model.name = name
  const description = optionalShort(raw.description, ASSIST_MODEL_DESCRIPTION_MAX)
  if (description) model.description = description
  if (typeof raw.installed === 'boolean') model.installed = raw.installed
  if (typeof raw.loaded === 'boolean') model.loaded = raw.loaded
  if (typeof raw.busy === 'boolean') model.busy = raw.busy
  if (typeof raw.idleSecs === 'number' && Number.isFinite(raw.idleSecs) && raw.idleSecs >= 0) {
    model.idleSecs = Math.floor(raw.idleSecs)
  }
  return model
}

export function normalizeAssistModels(raw: unknown): AssistModelList | null {
  if (!isRecord(raw)) return null
  const models: AssistModel[] = []
  for (const item of Array.isArray(raw.models) ? raw.models : []) {
    const model = assistModel(item)
    if (model && !models.some((m) => m.id === model.id)) models.push(model)
    if (models.length === ASSIST_MODELS_MAX) break
  }
  const list: AssistModelList = { lifecycle: raw.lifecycle === true, models }
  const error = normalizeAssistError(raw.error)
  if (error) list.error = error
  return list
}
