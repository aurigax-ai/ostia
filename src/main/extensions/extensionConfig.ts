import {
  CONNECTIONS_CHANGED_EVENT,
  type ExtensionConnectionEntry,
  type ExtensionConnectionResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionConnections'
import {
  type ExtensionInfo,
  type ExtensionSettingValues,
  effectiveSettingValues,
  SETTINGS_CHANGED_EVENT,
  validSettingValue,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type {
  ExtensionSecretResult,
  ExtensionSettingResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import type { PaneIdentity } from '../control/idRegistry'
import type { ExtensionHostDeps } from './extensionHostDeps'
import { fail, type Runtime } from './extensionRuntime'

function storedSettings(raw: unknown): Map<string, ExtensionSettingValues> {
  const out = new Map<string, ExtensionSettingValues>()
  if (!isRecord(raw)) return out
  for (const [extId, values] of Object.entries(raw)) {
    if (!isRecord(values)) continue
    const kept: ExtensionSettingValues = {}
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'string' || typeof value === 'boolean') kept[key] = value
      else if (typeof value === 'number' && Number.isFinite(value)) kept[key] = value
    }
    out.set(extId, kept)
  }
  return out
}

export interface ExtensionConfigHost {
  deps: Pick<ExtensionHostDeps, 'broadcast' | 'connections' | 'readExtensionSettings' | 'secrets'>
  runtimeOf(identity: PaneIdentity, conn: MessageConnection): Runtime
  runtimes: ReadonlyMap<string, Runtime>
  changed(rt?: Runtime): void
  list(): ExtensionInfo[]
  reloadAssistSettings(): void
}

export class ExtensionConfig {
  constructor(private readonly host: ExtensionConfigHost) {
    this.settings = storedSettings(host.deps.readExtensionSettings?.())
  }

  private settings: Map<string, ExtensionSettingValues>

  settingValues(rt: Runtime): ExtensionSettingValues {
    return effectiveSettingValues(
      rt.ext.manifest.contributes.settings,
      this.settings.get(rt.ext.manifest.id),
    )
  }

  getSettings(identity: PaneIdentity, conn: MessageConnection) {
    const rt = this.host.runtimeOf(identity, conn)
    return { ok: true, values: this.settingValues(rt) }
  }

  setOwnSetting(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const p = (params ?? {}) as { key?: unknown; value?: unknown }
    if (typeof p.key !== 'string') return fail('invalid-params', 'key')
    const extId = rt.ext.manifest.id
    const res = this.setSetting(extId, p.key, p.value === undefined ? null : p.value)
    if (!res.ok) return fail(res.error)
    this.host.deps.broadcast('extensions:settings-stored', { extId, stored: res.stored })
    return { ok: true, values: this.settingValues(rt) }
  }

  private sendSettings(rt: Runtime): void {
    if (!rt.conn || rt.ext.manifest.contributes.settings.length === 0) return
    const payload = { values: this.settingValues(rt) }
    void rt.conn
      .sendNotification('ext.event', { type: SETTINGS_CHANGED_EVENT, payload })
      .catch(() => {})
  }

  setSetting(extId: string, key: string, value: unknown): ExtensionSettingResult {
    const rt = this.host.runtimes.get(extId)
    if (!rt) return { ok: false, error: 'unknown-extension' }
    const setting = rt.ext.manifest.contributes.settings.find((s) => s.key === key)
    if (!setting) return { ok: false, error: 'unknown-setting' }
    const stored: ExtensionSettingValues = { ...(this.settings.get(extId) ?? {}) }
    if (value === null) delete stored[key]
    else if (validSettingValue(setting, value)) stored[key] = value
    else return { ok: false, error: 'invalid-value' }
    this.settings.set(extId, stored)
    this.sendSettings(rt)
    this.host.changed(rt)
    return { ok: true, stored, list: this.host.list() }
  }

  reloadSettings(): void {
    const before = new Map(
      [...this.host.runtimes].map(([id, rt]) => [id, JSON.stringify(this.settingValues(rt))]),
    )
    this.settings = storedSettings(this.host.deps.readExtensionSettings?.())
    for (const [id, rt] of this.host.runtimes) {
      if (before.get(id) !== JSON.stringify(this.settingValues(rt))) this.sendSettings(rt)
    }
    this.host.reloadAssistSettings()
    this.host.changed()
  }

  getSecret(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const key = (params as { key?: unknown } | null)?.key
    const declared = rt.ext.manifest.contributes.secrets.some((s) => s.key === key)
    if (typeof key !== 'string' || !declared) {
      return fail('not-contributed', `no secret '${String(key)}' in manifest`)
    }
    return { ok: true, value: this.host.deps.secrets?.get(rt.ext.manifest.id, key) ?? null }
  }

  setSecret(extId: string, key: string, value: unknown): ExtensionSecretResult {
    const rt = this.host.runtimes.get(extId)
    if (!rt) return { ok: false, error: 'unknown-extension' }
    if (!rt.ext.manifest.contributes.secrets.some((s) => s.key === key)) {
      return { ok: false, error: 'unknown-secret' }
    }
    if (value !== null && typeof value !== 'string') return { ok: false, error: 'invalid-value' }
    if (!this.host.deps.secrets) return { ok: false, error: 'encryption-unavailable' }
    const res = this.host.deps.secrets.set(extId, key, value)
    if (!res.ok) return res
    if (rt.conn) {
      const payload = { values: this.settingValues(rt) }
      void rt.conn
        .sendNotification('ext.event', { type: SETTINGS_CHANGED_EVENT, payload })
        .catch(() => {})
    }
    this.host.changed(rt)
    return { ok: true, list: this.host.list() }
  }

  connectionsOf(extId: string): ExtensionConnectionEntry[] {
    const rt = this.host.runtimes.get(extId)
    if (!rt || !this.host.deps.connections) return []
    return this.host.deps.connections.list(extId, rt.ext.manifest.contributes.connections ?? [])
  }

  saveConnection(extId: string, req: unknown): ExtensionConnectionResult {
    const rt = this.host.runtimes.get(extId)
    if (!rt) return { ok: false, error: 'unknown-extension' }
    const kinds = rt.ext.manifest.contributes.connections ?? []
    if (kinds.length === 0) return { ok: false, error: 'not-contributed' }
    if (!this.host.deps.connections) return { ok: false, error: 'unavailable' }
    const res = this.host.deps.connections.save(extId, kinds, req)
    if (res.ok) this.connectionsChanged(rt)
    return res
  }

  removeConnection(extId: string, name: unknown): ExtensionConnectionResult {
    const rt = this.host.runtimes.get(extId)
    if (!rt) return { ok: false, error: 'unknown-extension' }
    if (!this.host.deps.connections) return { ok: false, error: 'unavailable' }
    const res = this.host.deps.connections.remove(extId, name)
    if (res.ok) this.connectionsChanged(rt)
    return res
  }

  private connectionsChanged(rt: Runtime): void {
    if (rt.conn) {
      void rt.conn
        .sendNotification('ext.event', { type: CONNECTIONS_CHANGED_EVENT, payload: {} })
        .catch(() => {})
    }
    this.host.changed(rt)
  }

  listConnections(identity: PaneIdentity, conn: MessageConnection) {
    const rt = this.host.runtimeOf(identity, conn)
    const kinds = rt.ext.manifest.contributes.connections ?? []
    return {
      ok: true,
      connections: this.host.deps.connections?.names(rt.ext.manifest.id, kinds) ?? [],
    }
  }

  getConnection(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const kinds = rt.ext.manifest.contributes.connections ?? []
    const name = (params as { name?: unknown } | null)?.name
    if (typeof name !== 'string') return fail('invalid-params', 'name must be a string')
    return {
      ok: true,
      connection: this.host.deps.connections?.value(rt.ext.manifest.id, kinds, name) ?? null,
    }
  }
}
