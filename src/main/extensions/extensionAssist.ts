import {
  ASSIST_ERRORS,
  ASSIST_POINTS,
  ASSIST_UIS,
  type AssistAvailability,
  type AssistCatalog,
  type AssistError,
  type AssistExtensionState,
  type AssistKeyResult,
  type AssistModelChangeResult,
  type AssistModelSettings,
  type AssistModelsResult,
  type AssistOpenUiRequest,
  type AssistPoint,
  type AssistProviderEntry,
  type AssistProviderInfo,
  type AssistResponse,
  type AssistResults,
  type AssistUi,
  CHAT_STREAM_MAX,
  choiceLabel,
} from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import {
  normalizeAssistRequest,
  normalizeAssistResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/assistPayloads'
import {
  isAssistModelId,
  normalizeAssistError,
  normalizeAssistFeatures,
  normalizeAssistLabel,
  normalizeAssistModels,
  normalizeAssistStatus,
  normalizeModelRef,
  normalizeProviderKinds,
  normalizeProviderStates,
  normalizeSetupProblem,
  parseAssistModelSettings,
} from '@aurigax-ai/ostia-extension-sdk/contract/assistReports'
import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import {
  ASSIST_PROVIDERS_CHANGED_EVENT,
  type ExtensionSettingValues,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { isEqual } from 'es-toolkit'
import {
  type CancellationToken,
  CancellationTokenSource,
  type MessageConnection,
} from 'vscode-jsonrpc/node'
import type { PaneIdentity } from '../control/idRegistry'
import { redactAssistRequest } from '../privacy/redactionTargets'
import { AssistModelChoices } from './assistModelChoices'
import type { ExtensionHostDeps } from './extensionHostDeps'
import {
  type AssistRuntimeReport,
  cancelled,
  fail,
  type Runtime,
  withTimeout,
} from './extensionRuntime'

const ASSIST_TIMEOUT_MS = 60_000

const ASSIST_CHAT_TIMEOUT_MS = 5 * 60_000

const ASSIST_MODELS_TIMEOUT_MS = 15_000

const ASSIST_MODEL_CHANGE_TIMEOUT_MS = 5 * 60_000

const ASSIST_CHUNK_MAX = 262_144

interface AssistStream {
  rt: Runtime
  onChunk: (text: string) => void
  sent: number
}

export interface AssistCallOptions {
  onChunk?: (text: string) => void
  token?: CancellationToken
  model?: unknown
}

function assistReply<P extends AssistPoint>(point: P, raw: unknown): AssistResponse<P> {
  const error = isRecord(raw) ? raw.error : undefined
  if (ASSIST_ERRORS.includes(error as AssistError)) {
    const message = isRecord(raw) && typeof raw.message === 'string' ? raw.message : undefined
    return message
      ? { ok: false, error: error as AssistError, message: message.slice(0, 500) }
      : { ok: false, error: error as AssistError }
  }
  return { ok: true, result: normalizeAssistResult(point, raw) }
}

export function withoutCorrection<P extends AssistPoint>(
  point: P,
  response: AssistResponse<P>,
): AssistResponse<P> {
  if (point !== 'input' || !response.ok) return response
  const { corrected: _corrected, ...result } = response.result as AssistResults['input']
  return { ok: true, result: result as AssistResults[P] }
}

const SHORTCUT_IDS_MAX = 64

const SHORTCUT_LABEL_MAX = 40

const SHORTCUT_ID_MAX = 120

export interface ExtensionAssistHost {
  deps: Pick<
    ExtensionHostDeps,
    | 'assistChatTimeoutMs'
    | 'assistKeys'
    | 'assistModelsTimeoutMs'
    | 'assistTimeoutMs'
    | 'broadcast'
    | 'openAssistUiIn'
    | 'readAssistSettings'
    | 'redact'
  >
  active(rt: Runtime): boolean
  granted(rt: Runtime): Capability[]
  runtimes: ReadonlyMap<string, Runtime>
  shownName(rt: Runtime): string
  runtimeOf(identity: PaneIdentity, conn: MessageConnection): Runtime
  onDemand(rt: Runtime): boolean
  eager(rt: Runtime): boolean
  start(rt: Runtime): void
  settingValues(rt: Runtime): ExtensionSettingValues
}

export class ExtensionAssist {
  private readonly choices: AssistModelChoices

  constructor(private readonly host: ExtensionAssistHost) {
    this.assistSettings = parseAssistModelSettings(host.deps.readAssistSettings?.()?.assistant)
    this.choices = new AssistModelChoices({
      runtimes: host.runtimes,
      active: (rt) => host.active(rt),
      granted: (rt) => host.granted(rt),
      shownName: (rt) => host.shownName(rt),
      settings: () => this.assistSettings,
    })
  }

  private assistSettings: AssistModelSettings

  private assistStreams = new Map<string, AssistStream>()

  private assistSeq = 0

  assistChanged(): void {
    this.host.deps.broadcast('assist:availability', this.assistAvailability())
    this.host.deps.broadcast('assist:overview', this.assistOverview())
    this.host.deps.broadcast('assist:catalog', this.assistCatalog())
  }

  assistCatalog(): AssistCatalog {
    const models = this.choices.modelChoices()
    return {
      models,
      chat: this.choices.selectedChoice('chat', models)?.ref ?? null,
      fast: this.choices.selectedChoice('fast', models)?.ref ?? null,
    }
  }

  assistAvailability(): AssistAvailability {
    const out: AssistAvailability = {}
    for (const point of ASSIST_POINTS) {
      const target = this.choices.assistTarget(point, null)
      if (!target) continue
      const { rt, choice } = target
      const status = rt.assistStatus[point]
      const info: AssistProviderInfo = {
        extId: rt.ext.manifest.id,
        name: this.host.shownName(rt),
        ref: choice.ref,
      }
      const label = choice.ref.provider ? choiceLabel(choice) : status?.label
      const tools = choice.ref.provider ? choice.tools : status?.tools
      if (label) info.label = label
      if (tools && point === 'chat') info.tools = tools
      out[point] = info
    }
    return out
  }

  assistEntries(rt: Runtime): AssistProviderEntry[] {
    const extId = rt.ext.manifest.id
    return this.assistSettings.providers
      .filter((p) => p.extId === extId && p.enabled)
      .map((p) => ({
        id: p.id,
        kind: p.kind,
        name: p.name,
        baseUrl: p.baseUrl,
        models: p.models,
        apiKey: this.host.deps.assistKeys?.get(extId, p.id) ?? null,
      }))
  }

  getAssistProviders(identity: PaneIdentity, conn: MessageConnection) {
    const rt = this.host.runtimeOf(identity, conn)
    if (rt.ext.manifest.contributes.assist.length === 0) {
      return fail('not-contributed', 'manifest does not contribute assist')
    }
    return { ok: true, providers: this.assistEntries(rt) }
  }

  private sendAssistProviders(rt: Runtime): void {
    if (!rt.conn || rt.ext.manifest.contributes.assist.length === 0) return
    if (!this.host.granted(rt).includes('assist')) return
    const payload = { providers: this.assistEntries(rt) }
    void rt.conn
      .sendNotification('ext.event', { type: ASSIST_PROVIDERS_CHANGED_EVENT, payload })
      .catch(() => {})
  }

  reloadAssistSettings(): void {
    const file = this.host.deps.readAssistSettings?.()
    if (!file) return
    const next = parseAssistModelSettings(file.assistant)
    if (isEqual(next, this.assistSettings)) return
    const before = new Map(
      [...this.host.runtimes].map(([id, rt]) => [id, JSON.stringify(this.assistEntries(rt))]),
    )
    const waiting = [...this.host.runtimes.values()].filter((rt) => this.host.onDemand(rt))
    this.assistSettings = next
    const keys = this.host.deps.assistKeys
    for (const [id, rt] of this.host.runtimes) {
      for (const key of keys?.keys(id) ?? []) {
        const kept = this.assistSettings.providers.some((p) => p.extId === id && p.id === key)
        if (!kept) keys?.set(id, key, null)
      }
      if (before.get(id) !== JSON.stringify(this.assistEntries(rt))) this.sendAssistProviders(rt)
      if (waiting.includes(rt) && this.host.eager(rt)) this.host.start(rt)
    }
    this.assistChanged()
  }

  setAssistProviderKey(providerId: unknown, value: unknown): AssistKeyResult {
    const config = this.assistSettings.providers.find((p) => p.id === providerId)
    if (!config) return { ok: false, error: 'unknown-provider' }
    if (value !== null && typeof value !== 'string') return { ok: false, error: 'invalid-value' }
    if (!this.host.deps.assistKeys) return { ok: false, error: 'encryption-unavailable' }
    const res = this.host.deps.assistKeys.set(config.extId, config.id, value)
    if (!res.ok) return res
    const rt = this.host.runtimes.get(config.extId)
    if (rt) this.sendAssistProviders(rt)
    this.assistChanged()
    return { ok: true }
  }

  setAssistStatus(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const contributed = rt.ext.manifest.contributes.assist
    if (contributed.length === 0)
      return fail('not-contributed', 'manifest does not contribute assist')
    const p = (params ?? {}) as Record<string, unknown>
    const status = normalizeAssistStatus(p.status)
    rt.assistStatus = Object.fromEntries(
      Object.entries(status).filter(([point]) => contributed.includes(point as AssistPoint)),
    )
    const booleans = new Set(
      rt.ext.manifest.contributes.settings.filter((s) => s.type === 'boolean').map((s) => s.key),
    )
    const report: AssistRuntimeReport = {
      features: normalizeAssistFeatures(p.features).filter((f) => booleans.has(f.setting)),
      setup: normalizeSetupProblem(p.setup),
      models: p.models === true,
      kinds: normalizeProviderKinds(p.kinds),
    }
    if (Array.isArray(p.providers)) report.providers = normalizeProviderStates(p.providers)
    const lastError = normalizeAssistError(p.lastError)
    if (lastError) report.lastError = lastError
    const label = normalizeAssistLabel(p.label)
    if (label) report.label = label
    rt.assistReport = report
    this.assistChanged()
    return { ok: true }
  }

  assistOverview(): AssistExtensionState[] {
    const out: AssistExtensionState[] = []
    for (const rt of this.host.runtimes.values()) {
      const report = rt.assistReport
      if (!report || !this.choices.servesAssist(rt)) continue
      const values = this.host.settingValues(rt)
      const extId = rt.ext.manifest.id
      const state: AssistExtensionState = {
        extId,
        name: this.host.shownName(rt),
        setup: report.setup,
        features: report.features.map((f) => ({ ...f, on: values[f.setting] === true })),
        models: report.models,
        providers: report.providers ?? [],
        kinds: report.kinds,
        keysSet: this.host.deps.assistKeys?.keys(extId) ?? [],
      }
      if (report.label) state.label = report.label
      if (report.lastError) state.lastError = report.lastError
      out.push(state)
    }
    return out
  }

  private modelsRuntime(extId: unknown): Runtime | null {
    if (typeof extId !== 'string') return null
    const rt = this.host.runtimes.get(extId)
    if (!rt?.conn || !rt.assistReport?.models || !this.host.active(rt)) return null
    return this.host.granted(rt).includes('assist') ? rt : null
  }

  async assistModels(extId: unknown, provider?: unknown): Promise<AssistModelsResult> {
    const rt = this.modelsRuntime(extId)
    const conn = rt?.conn
    if (!rt || !conn) return { ok: false, error: 'unavailable' }
    const target = typeof provider === 'string' ? { provider } : {}
    try {
      const reply = await withTimeout(
        conn.sendRequest('ext.assistModels', { action: 'list', ...target }),
        this.host.deps.assistModelsTimeoutMs ?? ASSIST_MODELS_TIMEOUT_MS,
        `${rt.ext.manifest.id} models`,
      )
      const list = normalizeAssistModels(reply)
      return list ? { ok: true, ...list } : { ok: false, error: 'invalid' }
    } catch (err) {
      return { ok: false, error: normalizeAssistError((err as Error).message) ?? 'failed' }
    }
  }

  async setAssistModelLoaded(
    extId: unknown,
    id: unknown,
    loaded: unknown,
    provider?: unknown,
  ): Promise<AssistModelChangeResult> {
    if (!isAssistModelId(id) || typeof loaded !== 'boolean') return { ok: false, error: 'invalid' }
    const rt = this.modelsRuntime(extId)
    const conn = rt?.conn
    if (!rt || !conn) return { ok: false, error: 'unavailable' }
    const target = typeof provider === 'string' ? { provider } : {}
    try {
      const reply = (await withTimeout(
        conn.sendRequest('ext.assistModels', {
          action: loaded ? 'load' : 'unload',
          id,
          ...target,
        }),
        this.host.deps.assistModelsTimeoutMs ?? ASSIST_MODEL_CHANGE_TIMEOUT_MS,
        `${rt.ext.manifest.id} models`,
      )) as { ok?: unknown; error?: unknown } | null
      if (reply?.ok === true) return { ok: true }
      return { ok: false, error: normalizeAssistError(reply?.error) ?? 'failed' }
    } catch (err) {
      return { ok: false, error: normalizeAssistError((err as Error).message) ?? 'failed' }
    }
  }

  openAssistUi(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const p = (params ?? {}) as { ui?: unknown; workspaceId?: unknown }
    if (!ASSIST_UIS.includes(p.ui as AssistUi)) {
      return fail('invalid-params', `ui must be one of ${ASSIST_UIS.join(', ')}`)
    }
    const ui = p.ui as AssistUi
    const needs: AssistPoint[] = ui === 'compose' ? ['input', 'command'] : ['chat']
    if (!needs.some((point) => rt.ext.manifest.contributes.assist.includes(point))) {
      return fail('not-contributed', `manifest does not contribute ${needs.join(' or ')}`)
    }
    const req: AssistOpenUiRequest = { extId: rt.ext.manifest.id, ui }
    if (typeof p.workspaceId === 'string' && p.workspaceId) req.workspaceId = p.workspaceId
    if (!this.host.deps.openAssistUiIn) return fail('no-window')
    this.host.deps.openAssistUiIn(req)
    return { ok: true }
  }

  async assist<P extends AssistPoint>(
    point: P,
    input: unknown,
    opts: AssistCallOptions = {},
  ): Promise<AssistResponse<P>> {
    const normalized = normalizeAssistRequest(point, input)
    if (!normalized) return { ok: false, error: 'invalid' }
    let request = normalized
    let redacted = 0
    if (this.host.deps.redact) {
      try {
        const safe = await redactAssistRequest(point, normalized, this.host.deps.redact)
        request = safe.request
        redacted = safe.count
      } catch {
        return { ok: false, error: 'failed' }
      }
    }
    const explicit = opts.model === undefined ? null : normalizeModelRef(opts.model)
    if (opts.model !== undefined && !explicit) return { ok: false, error: 'invalid' }
    const target = this.choices.assistTarget(point, explicit)
    const rt = target?.rt
    const conn = rt?.conn
    if (!target || !rt || !conn) return { ok: false, error: 'unavailable' }
    const { provider, model } = target.choice.ref
    const routed = provider && model ? { model: { provider, model } } : {}
    const requestId = `a${++this.assistSeq}`
    this.assistStreams.set(requestId, { rt, onChunk: opts.onChunk ?? (() => {}), sent: 0 })
    const source = new CancellationTokenSource()
    const sub = opts.token?.onCancellationRequested(() => source.cancel())
    const timeoutMs =
      point === 'chat'
        ? (this.host.deps.assistChatTimeoutMs ?? ASSIST_CHAT_TIMEOUT_MS)
        : (this.host.deps.assistTimeoutMs ?? ASSIST_TIMEOUT_MS)
    try {
      const reply = await Promise.race([
        withTimeout(
          conn.sendRequest(
            'ext.assist',
            { point, requestId, input: request, ...routed },
            source.token,
          ),
          timeoutMs,
          `${rt.ext.manifest.id} assist`,
        ),
        cancelled(opts.token),
      ])
      if (reply === 'cancelled' || opts.token?.isCancellationRequested) {
        return { ok: false, error: 'cancelled' }
      }
      const response = assistReply(point, reply)
      return redacted > 0 ? withoutCorrection(point, response) : response
    } catch (err) {
      if (opts.token?.isCancellationRequested) return { ok: false, error: 'cancelled' }
      return { ok: false, error: 'failed', message: (err as Error).message }
    } finally {
      source.cancel()
      source.dispose()
      sub?.dispose()
      this.assistStreams.delete(requestId)
    }
  }

  assistChunk(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const p = (params ?? {}) as { requestId?: unknown; text?: unknown }
    const stream = typeof p.requestId === 'string' ? this.assistStreams.get(p.requestId) : undefined
    if (!stream || stream.rt !== rt) return { ok: true, live: false }
    if (typeof p.text !== 'string') return fail('invalid-params', 'text must be a string')
    const room = Math.min(ASSIST_CHUNK_MAX, CHAT_STREAM_MAX - stream.sent)
    if (p.text.startsWith('{') && p.text.length > room) return { ok: true, live: false }
    const text = p.text.slice(0, room)
    if (!text) return { ok: true, live: stream.sent < CHAT_STREAM_MAX }
    stream.sent += text.length
    stream.onChunk(text)
    return { ok: true, live: true }
  }

  dropAssistStreams(rt: Runtime): void {
    for (const [id, stream] of this.assistStreams) {
      if (stream.rt === rt) this.assistStreams.delete(id)
    }
  }

  private shortcuts: Record<string, string> = {}

  wakeAssist(): void {
    for (const rt of this.host.runtimes.values()) {
      if (rt.ext.manifest.contributes.assist.length > 0 && rt.state !== 'crashed')
        this.host.start(rt)
    }
  }

  setShortcuts(raw: unknown): void {
    const next: Record<string, string> = {}
    if (isRecord(raw)) {
      for (const [id, label] of Object.entries(raw)) {
        if (id.length > SHORTCUT_ID_MAX || typeof label !== 'string' || !label) continue
        next[id] = label.slice(0, SHORTCUT_LABEL_MAX)
      }
    }
    this.shortcuts = next
  }

  getShortcuts(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    this.host.runtimeOf(identity, conn)
    const ids = (params as { ids?: unknown } | null)?.ids
    if (!Array.isArray(ids) || ids.length > SHORTCUT_IDS_MAX) {
      return fail('invalid-params', `ids must be an array of at most ${SHORTCUT_IDS_MAX}`)
    }
    const shortcuts: Record<string, string | null> = {}
    for (const id of ids) {
      if (typeof id === 'string')
        shortcuts[id] = Object.hasOwn(this.shortcuts, id) ? this.shortcuts[id] : null
    }
    return { ok: true, shortcuts }
  }
}
