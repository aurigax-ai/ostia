import { safeStorage } from 'electron'
import { ensureCaps } from '../approvals/controlElevation'
import { registerControlMethod } from '../control/controlServer'
import { type StoreScope, loadJson, saveJson, storePath } from '../platform/jsonStore'
import { workDirForWorkspace } from '../workspaces/workspaceRegistry'

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
      'no project workDir is known for this workspace yet, so a project-scoped vault would ' +
      "collapse into a shared default — pass `--global`, or retry once the pane's project " +
      'is resolved.',
  }
}

function vaultStorePath(scope: StoreScope, workspaceId: string): string | NoProjectWorkDir {
  if (scope === 'global') return storePath('vault', 'global')
  const workDir = workDirForWorkspace(workspaceId)
  if (!workDir) return noProjectWorkDir()
  return storePath('vault', 'project', workDir)
}

function loadVault(path: string): VaultData {
  return loadJson<VaultData>(path, {})
}

function saveVault(path: string, data: VaultData): void {
  saveJson(path, data, { secure: true })
}

export interface VaultDeps {
  isSandboxed?: (workspaceId: string) => boolean
}

export function registerVaultMethods(deps: VaultDeps = {}): void {
  registerControlMethod('vault.set', {
    cap: 'vault-write',
    handler: async (params, ctx) => {
      if (!safeStorage.isEncryptionAvailable()) return encryptionUnavailable()
      const { key, value, scope } = (params ?? {}) as {
        key: string
        value: string
        scope?: StoreScope
      }
      const resolvedScope = scope ?? 'project'
      if (resolvedScope === 'global') {
        await ensureCaps(ctx.authed, ctx.identity, ['all-workspaces'], 'vault (global scope)', '')
      }
      const path = vaultStorePath(resolvedScope, ctx.identity.workspaceId)
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
      if (deps.isSandboxed?.(ctx.identity.workspaceId)) {
        return {
          ok: false,
          error: 'sandboxed',
          message: 'this workspace is sandboxed: ask for the value with `ostia secret get <name>`',
        }
      }
      if (!safeStorage.isEncryptionAvailable()) return encryptionUnavailable()
      const { key, scope } = (params ?? {}) as { key: string; scope?: StoreScope }
      const path = vaultStorePath(scope ?? 'project', ctx.identity.workspaceId)
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
      const path = vaultStorePath(scope ?? 'project', ctx.identity.workspaceId)
      if (typeof path !== 'string') return path
      return { keys: Object.keys(loadVault(path)) }
    },
  })

  registerControlMethod('vault.delete', {
    cap: 'vault-write',
    handler: async (params, ctx) => {
      if (!safeStorage.isEncryptionAvailable()) return encryptionUnavailable()
      const { key, scope } = (params ?? {}) as { key: string; scope?: StoreScope }
      const resolvedScope = scope ?? 'project'
      if (resolvedScope === 'global') {
        await ensureCaps(ctx.authed, ctx.identity, ['all-workspaces'], 'vault (global scope)', '')
      }
      const path = vaultStorePath(resolvedScope, ctx.identity.workspaceId)
      if (typeof path !== 'string') return path
      const store = loadVault(path)
      delete store[key]
      saveVault(path, store)
      return { ok: true }
    },
  })
}

export function setGlobalVaultValue(key: string, value: string): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  const path = storePath('vault', 'global')
  const store = loadVault(path)
  store[key] = safeStorage.encryptString(value).toString('base64')
  saveVault(path, store)
  return true
}

export function deleteGlobalVaultValue(key: string): boolean {
  const path = storePath('vault', 'global')
  const store = loadVault(path)
  if (!(key in store)) return false
  delete store[key]
  saveVault(path, store)
  return true
}

export function vaultKeys(scope: StoreScope, workspaceId: string): string[] {
  const path = vaultStorePath(scope, workspaceId)
  return typeof path === 'string' ? Object.keys(loadVault(path)) : []
}

export function vaultValue(key: string, scope: StoreScope, workspaceId: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  const path = vaultStorePath(scope, workspaceId)
  if (typeof path !== 'string') return null
  const raw = loadVault(path)[key]
  if (raw === undefined) return null
  try {
    return safeStorage.decryptString(Buffer.from(raw, 'base64'))
  } catch {
    return null
  }
}
