import { EXTENSION_SECRET_MAX } from '../../shared/extensions'
import { isDangerousSegment } from '../../shared/protoGuard'
import type { ExtensionSecretStore } from './extensionHost'

export type StoredSecrets = Record<string, Record<string, string>>

export interface SecretStoreDeps {
  load: () => unknown
  save: (data: StoredSecrets) => void
  canEncrypt: () => boolean
  encrypt: (plain: string) => string
  decrypt: (secret: string) => string
}

export function sanitizeSecrets(raw: unknown): StoredSecrets {
  const out: StoredSecrets = Object.create(null)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [extId, values] of Object.entries(raw)) {
    if (isDangerousSegment(extId) || typeof values !== 'object' || values === null) continue
    const kept: Record<string, string> = Object.create(null)
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (!isDangerousSegment(key) && typeof value === 'string') kept[key] = value
    }
    out[extId] = kept
  }
  return out
}

export function createSecretStore(deps: SecretStoreDeps): ExtensionSecretStore {
  const read = (): StoredSecrets => sanitizeSecrets(deps.load())
  return {
    keys: (extId) => Object.keys(read()[extId] ?? {}).sort(),
    get: (extId, key) => {
      const stored = read()[extId]?.[key]
      if (stored === undefined || !deps.canEncrypt()) return null
      try {
        return deps.decrypt(stored)
      } catch {
        return null
      }
    },
    set: (extId, key, value) => {
      if (isDangerousSegment(extId) || isDangerousSegment(key)) {
        return { ok: false, error: 'invalid-key' }
      }
      const data = read()
      const values = { ...(data[extId] ?? {}) }
      if (value === null) {
        delete values[key]
      } else {
        if (!value || value.length > EXTENSION_SECRET_MAX)
          return { ok: false, error: 'invalid-value' }
        if (!deps.canEncrypt()) return { ok: false, error: 'encryption-unavailable' }
        values[key] = deps.encrypt(value)
      }
      data[extId] = values
      if (Object.keys(values).length === 0) delete data[extId]
      deps.save({ ...data })
      return { ok: true }
    },
  }
}
