/**
 * `vault` toolbelt service (agent-toolbelt #10, capabilities 'vault-read'/'vault-write' —
 * elevated: secrets are the most sensitive thing an agent can touch). Encrypted key/value
 * secret storage for agents, isolated per project (default, scoped to the caller's session
 * workDir) or globally to the machine. Values are encrypted at rest with Electron's
 * OS-keychain-backed `safeStorage` API before ever touching `jsonStore`'s JSON file — the
 * file on disk only ever holds base64 ciphertext, never plaintext.
 *
 * `safeStorage.isEncryptionAvailable()` can be false (e.g. Linux without a keyring
 * backend running/unlocked). When it is, every method below fails closed with a typed
 * `encryption-unavailable` error instead of silently falling back to storing plaintext.
 */
import { safeStorage } from 'electron'
import { registerControlMethod } from './controlServer'
import { type StoreScope, loadJson, saveJson, storePath } from './jsonStore'
import { workDirForSession } from './sessionRegistry'

/** key → base64(safeStorage.encryptString(value)) */
type VaultData = Record<string, string>

const ENCRYPTION_UNAVAILABLE_MESSAGE =
  'Secret encryption is unavailable on this system (no OS keyring backend found). ' +
  'On Linux, install and unlock a keyring (e.g. gnome-keyring or kwallet) so Electron’s ' +
  'safeStorage can encrypt secrets at rest, then try again.'

function encryptionUnavailable(): { ok: false; error: 'encryption-unavailable'; message: string } {
  return { ok: false, error: 'encryption-unavailable', message: ENCRYPTION_UNAVAILABLE_MESSAGE }
}

/** project = the caller's session workDir; global = the machine-wide store (see `jsonStore`). */
function vaultStorePath(scope: StoreScope, sessionId: string): string {
  return storePath('vault', scope, scope === 'project' ? workDirForSession(sessionId) : undefined)
}

function loadVault(scope: StoreScope, sessionId: string): VaultData {
  return loadJson<VaultData>(vaultStorePath(scope, sessionId), {})
}

function saveVault(scope: StoreScope, sessionId: string, data: VaultData): void {
  saveJson(vaultStorePath(scope, sessionId), data)
}

export function registerVaultMethods(): void {
  registerControlMethod('vault.set', {
    cap: 'vault-write',
    handler: (params, ctx) => {
      if (!safeStorage.isEncryptionAvailable()) return encryptionUnavailable()
      const { key, value, scope } = (params ?? {}) as {
        key: string
        value: string
        scope?: StoreScope
      }
      const s = scope ?? 'project'
      const store = loadVault(s, ctx.identity.sessionId)
      store[key] = safeStorage.encryptString(value).toString('base64')
      saveVault(s, ctx.identity.sessionId, store)
      return { ok: true }
    },
  })

  registerControlMethod('vault.get', {
    cap: 'vault-read',
    handler: (params, ctx) => {
      if (!safeStorage.isEncryptionAvailable()) return encryptionUnavailable()
      const { key, scope } = (params ?? {}) as { key: string; scope?: StoreScope }
      const s = scope ?? 'project'
      const store = loadVault(s, ctx.identity.sessionId)
      const raw = store[key]
      if (raw === undefined) return { ok: false, error: 'not-found' }
      try {
        return { value: safeStorage.decryptString(Buffer.from(raw, 'base64')) }
      } catch {
        return {
          ok: false,
          error: 'decrypt-failed',
          message: 'stored value could not be decrypted',
        }
      }
    },
  })

  registerControlMethod('vault.list', {
    cap: 'vault-read',
    handler: (params, ctx) => {
      if (!safeStorage.isEncryptionAvailable()) return encryptionUnavailable()
      const { scope } = (params ?? {}) as { scope?: StoreScope }
      const s = scope ?? 'project'
      // KEYS ONLY — never return decrypted (or even encrypted) values here.
      return { keys: Object.keys(loadVault(s, ctx.identity.sessionId)) }
    },
  })

  registerControlMethod('vault.delete', {
    cap: 'vault-write',
    handler: (params, ctx) => {
      if (!safeStorage.isEncryptionAvailable()) return encryptionUnavailable()
      const { key, scope } = (params ?? {}) as { key: string; scope?: StoreScope }
      const s = scope ?? 'project'
      const store = loadVault(s, ctx.identity.sessionId)
      delete store[key]
      saveVault(s, ctx.identity.sessionId, store)
      return { ok: true }
    },
  })
}
