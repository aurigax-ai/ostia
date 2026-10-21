import {
  type ConnectionInfo,
  type ConnectionValue,
  EXTENSION_CONNECTION_NAME_PATTERN,
  EXTENSION_CONNECTION_VALUE_MAX,
  EXTENSION_CONNECTIONS_MAX,
  type ExtensionConnectionEntry,
  type ExtensionConnectionKind,
  type ExtensionConnectionResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionConnections'
import { EXTENSION_SECRET_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { isDangerousSegment } from '@aurigax-ai/ostia-extension-sdk/contract/protoGuard'
import { loadJson, saveJson } from '../platform/jsonStore'
import type { ExtensionSecretStore } from './extensionHostDeps'

interface StoredConnection {
  kind: string
  fields: Record<string, string>
}

type StoredConnections = Record<string, Record<string, StoredConnection>>

const SECRET_PREFIX = '@connection/'

export function connectionSecretKey(name: string, key: string): string {
  return `${SECRET_PREFIX}${name}/${key}`
}

function stringFields(raw: unknown): Record<string, string> | null {
  if (!isRecord(raw)) return null
  const out: Record<string, string> = Object.create(null)
  for (const [key, value] of Object.entries(raw)) {
    if (isDangerousSegment(key) || typeof value !== 'string') return null
    out[key] = value
  }
  return out
}

function sanitize(raw: unknown): StoredConnections {
  const out: StoredConnections = Object.create(null)
  if (!isRecord(raw)) return out
  for (const [extId, entries] of Object.entries(raw)) {
    if (isDangerousSegment(extId) || !isRecord(entries)) continue
    const kept: Record<string, StoredConnection> = Object.create(null)
    for (const [name, value] of Object.entries(entries)) {
      if (!EXTENSION_CONNECTION_NAME_PATTERN.test(name) || !isRecord(value)) continue
      const fields = stringFields(value.fields)
      if (typeof value.kind !== 'string' || !fields) continue
      kept[name] = { kind: value.kind, fields }
    }
    out[extId] = kept
  }
  return out
}

function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function checkFields(kind: ExtensionConnectionKind, raw: unknown): Record<string, string> | string {
  const given = isRecord(raw) ? raw : {}
  const fields: Record<string, string> = Object.create(null)
  for (const key of Object.keys(given)) {
    if (!kind.fields.some((f) => f.key === key)) return `unknown field ${key}`
  }
  for (const field of kind.fields) {
    const value = Object.hasOwn(given, field.key) ? given[field.key] : field.default
    if (value === undefined || value === '') {
      if (field.required) return `${field.key} is required`
      continue
    }
    if (typeof value !== 'string' || value.length > EXTENSION_CONNECTION_VALUE_MAX) {
      return `${field.key} must be text of at most ${EXTENSION_CONNECTION_VALUE_MAX} characters`
    }
    if (hasControl(value)) return `${field.key} must not hold a control character`
    if (field.type === 'enum' && !(field.enum ?? []).includes(value)) {
      return `${field.key} must be one of ${(field.enum ?? []).join(', ')}`
    }
    fields[field.key] = value
  }
  return fields
}

function checkSecrets(
  kind: ExtensionConnectionKind,
  raw: unknown,
): Record<string, string | null> | string {
  if (raw === undefined) return {}
  if (!isRecord(raw)) return 'secrets must be an object'
  const out: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!kind.secrets.some((s) => s.key === key)) return `unknown secret ${key}`
    if (value === null) out[key] = null
    else if (typeof value !== 'string' || !value || value.length > EXTENSION_SECRET_MAX) {
      return `${key} must be 1-${EXTENSION_SECRET_MAX} characters`
    } else if (hasControl(value)) {
      return `${key} must not hold a control character such as a line break`
    } else out[key] = value
  }
  return out
}

export class ExtensionConnections {
  constructor(
    private readonly path: string,
    private readonly secrets: () => ExtensionSecretStore | undefined,
  ) {}

  private read(): StoredConnections {
    return sanitize(loadJson<unknown>(this.path, {}))
  }

  private stored(extId: string, kinds: readonly ExtensionConnectionKind[]) {
    const entries = this.read()[extId] ?? {}
    return Object.entries(entries)
      .filter(([, c]) => kinds.some((k) => k.kind === c.kind))
      .sort(([a], [b]) => a.localeCompare(b))
  }

  list(extId: string, kinds: readonly ExtensionConnectionKind[]): ExtensionConnectionEntry[] {
    const keys = this.secrets()?.keys(extId) ?? []
    return this.stored(extId, kinds).map(([name, c]) => ({
      name,
      kind: c.kind,
      fields: { ...c.fields },
      secretsSet: (kinds.find((k) => k.kind === c.kind)?.secrets ?? [])
        .map((s) => s.key)
        .filter((key) => keys.includes(connectionSecretKey(name, key))),
    }))
  }

  names(extId: string, kinds: readonly ExtensionConnectionKind[]): ConnectionInfo[] {
    return this.stored(extId, kinds).map(([name, c]) => ({ name, kind: c.kind }))
  }

  value(
    extId: string,
    kinds: readonly ExtensionConnectionKind[],
    name: unknown,
  ): ConnectionValue | null {
    if (typeof name !== 'string') return null
    const found = this.stored(extId, kinds).find(([n]) => n === name)
    if (!found) return null
    const [, c] = found
    const kind = kinds.find((k) => k.kind === c.kind)
    const store = this.secrets()
    const secrets: Record<string, string> = {}
    for (const secret of kind?.secrets ?? []) {
      const value = store?.get(extId, connectionSecretKey(name, secret.key))
      if (value) secrets[secret.key] = value
    }
    return { name, kind: c.kind, fields: { ...c.fields }, secrets }
  }

  save(
    extId: string,
    kinds: readonly ExtensionConnectionKind[],
    req: unknown,
  ): ExtensionConnectionResult {
    if (isDangerousSegment(extId) || !isRecord(req)) return { ok: false, error: 'invalid-request' }
    const { name, kind: kindName } = req
    if (typeof name !== 'string' || !EXTENSION_CONNECTION_NAME_PATTERN.test(name)) {
      return { ok: false, error: 'invalid-name' }
    }
    const kind = kinds.find((k) => k.kind === kindName)
    if (!kind) return { ok: false, error: 'unknown-kind' }
    const fields = checkFields(kind, req.fields)
    if (typeof fields === 'string') return { ok: false, error: `invalid-field: ${fields}` }
    const secrets = checkSecrets(kind, req.secrets)
    if (typeof secrets === 'string') return { ok: false, error: `invalid-secret: ${secrets}` }
    const data = this.read()
    const entries = { ...(data[extId] ?? {}) }
    const existing = entries[name]
    if (existing && existing.kind !== kind.kind) return { ok: false, error: 'kind-changed' }
    if (!existing && Object.keys(entries).length >= EXTENSION_CONNECTIONS_MAX) {
      return { ok: false, error: 'too-many-connections' }
    }
    const store = this.secrets()
    const writes = Object.entries(secrets)
    if (writes.some(([, v]) => v !== null) && !store) {
      return { ok: false, error: 'encryption-unavailable' }
    }
    for (const [key, value] of writes) {
      const res = store?.set(extId, connectionSecretKey(name, key), value)
      if (res && !res.ok) return res
    }
    entries[name] = { kind: kind.kind, fields }
    data[extId] = entries
    saveJson(this.path, data)
    return { ok: true }
  }

  remove(extId: string, name: unknown): ExtensionConnectionResult {
    if (typeof name !== 'string' || isDangerousSegment(extId)) {
      return { ok: false, error: 'invalid-name' }
    }
    const data = this.read()
    const entries = { ...(data[extId] ?? {}) }
    if (!Object.hasOwn(entries, name)) return { ok: false, error: 'unknown-connection' }
    delete entries[name]
    const store = this.secrets()
    for (const key of store?.keys(extId) ?? []) {
      if (key.startsWith(connectionSecretKey(name, ''))) store?.set(extId, key, null)
    }
    if (Object.keys(entries).length === 0) delete data[extId]
    else data[extId] = entries
    saveJson(this.path, data)
    return { ok: true }
  }

  forget(extId: string): void {
    const data = this.read()
    if (!Object.hasOwn(data, extId)) return
    delete data[extId]
    saveJson(this.path, data)
  }
}
