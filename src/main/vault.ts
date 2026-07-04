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
 *
 * Scope resolution also fails closed: `jsonStore.storePath` falls back to `process.cwd()`
 * when handed an empty workDir, which is the right default for a generic store but wrong
 * here — an unknown session's `process.cwd()` is main's own working directory, shared by
 * every caller, so falling back would silently pool every unrecognized session's secrets
 * into one vault. `project` scope therefore requires a resolved session workDir up front;
 * `global` scope is unaffected (it never depends on a workDir).
 *
 * `scope: 'global'` WRITES (`vault.set`/`vault.delete`) additionally require the elevated
 * `workspace-wide` capability on top of the default `vault-write` cap — a global write is
 * machine-wide, visible to every project's panes. Global READS stay default (see `wiki.ts`
 * for the same posture).
 */
import { safeStorage } from 'electron'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import type { Capability } from '../shared/capabilities'
import { connHasCap } from './controlAuth'
import { registerControlMethod } from './controlServer'
import { type StoreScope, loadJson, saveJson, storePath } from './jsonStore'
import { workDirForSession } from './sessionRegistry'

/** A JSON-RPC error matching `controlServer.ts`'s `needsElevation` (not exported from there). */
function needsElevation(cap: Capability): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, `needs-elevation: ${cap}`)
}

/** key → base64(safeStorage.encryptString(value)) */
type VaultData = Record<string, string>

const ENCRYPTION_UNAVAILABLE_MESSAGE =
  'Secret encryption is unavailable on this system (no OS keyring backend found). ' +
  'On Linux, install and unlock a keyring (e.g. gnome-keyring or kwallet) so Electron’s ' +
  'safeStorage can encrypt secrets at rest, then try again.'

function encryptionUnavailable(): { ok: false; error: 'encryption-unavailable'; message: string } {
  return { ok: false, error: 'encryption-unavailable', message: ENCRYPTION_UNAVAILABLE_MESSAGE }
}

interface NoProjectWorkDir {
  ok: false
  error: 'no-project-workdir'
  message: string
}

function noProjectWorkDir(): NoProjectWorkDir {
  return {
    ok: false,
    error: 'no-project-workdir',
    message:
      'no project workDir is known for this session yet, so a project-scoped vault would ' +
      "collapse into a shared default — pass `--global`, or retry once the pane's project " +
      'is resolved.',
  }
}

/**
 * project = the caller's session workDir; global = the machine-wide store (see `jsonStore`).
 * Fails closed (returns `NoProjectWorkDir`) rather than letting `jsonStore.storePath` fall
 * back to `process.cwd()` for a session whose workDir isn't registered yet.
 */
function vaultStorePath(scope: StoreScope, sessionId: string): string | NoProjectWorkDir {
  if (scope === 'global') return storePath('vault', 'global')
  const workDir = workDirForSession(sessionId)
  if (!workDir) return noProjectWorkDir()
  return storePath('vault', 'project', workDir)
}

function loadVault(path: string): VaultData {
  return loadJson<VaultData>(path, {})
}

function saveVault(path: string, data: VaultData): void {
  saveJson(path, data)
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
      const resolvedScope = scope ?? 'project'
      // `global` writes a machine-wide secret store every project's panes can see —
      // requires the elevated `workspace-wide` grant on top of the default `vault-write`
      // cap. Reads stay default (see `vault.get`/`vault.list`).
      if (resolvedScope === 'global' && !connHasCap(ctx.authed, 'workspace-wide')) {
        throw needsElevation('workspace-wide')
      }
      const path = vaultStorePath(resolvedScope, ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      const store = loadVault(path)
      store[key] = safeStorage.encryptString(value).toString('base64')
      saveVault(path, store)
      return { ok: true }
    },
  })

  registerControlMethod('vault.get', {
    cap: 'vault-read',
    handler: (params, ctx) => {
      if (!safeStorage.isEncryptionAvailable()) return encryptionUnavailable()
      const { key, scope } = (params ?? {}) as { key: string; scope?: StoreScope }
      const path = vaultStorePath(scope ?? 'project', ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      const store = loadVault(path)
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
      const path = vaultStorePath(scope ?? 'project', ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      // KEYS ONLY — never return decrypted (or even encrypted) values here.
      return { keys: Object.keys(loadVault(path)) }
    },
  })

  registerControlMethod('vault.delete', {
    cap: 'vault-write',
    handler: (params, ctx) => {
      if (!safeStorage.isEncryptionAvailable()) return encryptionUnavailable()
      const { key, scope } = (params ?? {}) as { key: string; scope?: StoreScope }
      const resolvedScope = scope ?? 'project'
      if (resolvedScope === 'global' && !connHasCap(ctx.authed, 'workspace-wide')) {
        throw needsElevation('workspace-wide')
      }
      const path = vaultStorePath(resolvedScope, ctx.identity.sessionId)
      if (typeof path !== 'string') return path
      const store = loadVault(path)
      delete store[key]
      saveVault(path, store)
      return { ok: true }
    },
  })
}
