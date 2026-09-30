import { ipcMain } from 'electron'
import { ResponseError } from 'vscode-jsonrpc/node'
import {
  type SandboxEditResult,
  type WorkspaceSandbox,
  parseSecretGrants,
} from '../../shared/sandbox'
import type { SecretEntry } from '../../shared/secrets'
import { registerControlMethod } from '../controlServer'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { SecretService } from './secretService'

export interface SecretsRegisterDeps {
  service: SecretService
  sandboxes: WorkspaceSandboxes
  ownerWindow: (workspaceId: string) => string | undefined
  vaultSet?: (key: string, value: string) => boolean
  vaultDelete?: (key: string) => boolean
  fill?: (
    workspaceId: string,
    paneId: string,
    origin: string,
    reason: string,
  ) => Promise<{ ok: boolean; error?: string }>
}

export interface SecretsView {
  secrets: SecretEntry[]
  grants: NonNullable<WorkspaceSandbox['secrets']>
}

export function registerSecretMethods(deps: SecretsRegisterDeps): void {
  registerControlMethod('secret.list', {
    handler: (_params, ctx) =>
      deps.service.list(ctx.identity.workspaceId).map(({ name, source, kind }) => ({
        name,
        source,
        kind,
      })),
  })
  registerControlMethod('secret.get', {
    handler: async (params, ctx) => {
      const { name, reason } = (params ?? {}) as { name?: unknown; reason?: unknown }
      if (typeof name !== 'string') throw new ResponseError(-32602, 'name must be a string')
      return deps.service.get(
        ctx.identity.workspaceId,
        ctx.identity.paneId,
        name,
        typeof reason === 'string' ? reason.slice(0, 500) : '',
      )
    },
  })
  registerControlMethod('secret.fill', {
    handler: async (params, ctx) => {
      const { origin, reason } = (params ?? {}) as { origin?: unknown; reason?: unknown }
      if (typeof origin !== 'string') throw new ResponseError(-32602, 'origin must be a string')
      if (!deps.fill) return { ok: false, error: 'unsupported' }
      return deps.fill(
        ctx.identity.workspaceId,
        ctx.identity.paneId,
        origin,
        typeof reason === 'string' ? reason.slice(0, 500) : '',
      )
    },
  })

  const owns = (senderId: number, workspaceId: unknown): workspaceId is string =>
    typeof workspaceId === 'string' && deps.ownerWindow(workspaceId) === String(senderId)

  ipcMain.handle('secrets:view', (e, workspaceId: unknown): SecretsView | null =>
    owns(e.sender.id, workspaceId)
      ? {
          secrets: deps.service.list(workspaceId),
          grants: deps.sandboxes.settings(workspaceId).secrets ?? [],
        }
      : null,
  )
  ipcMain.handle('secrets:vault-set', (e, workspaceId: unknown, key: unknown, value: unknown) => {
    if (!owns(e.sender.id, workspaceId) || typeof key !== 'string' || typeof value !== 'string') {
      return false
    }
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key) || value.length === 0) return false
    return deps.vaultSet?.(key, value) ?? false
  })
  ipcMain.handle('secrets:vault-delete', (e, workspaceId: unknown, key: unknown) =>
    owns(e.sender.id, workspaceId) && typeof key === 'string'
      ? (deps.vaultDelete?.(key) ?? false)
      : false,
  )
  ipcMain.handle(
    'secrets:set-grants',
    (e, workspaceId: unknown, grants: unknown): SandboxEditResult => {
      if (!owns(e.sender.id, workspaceId)) return { ok: false, errors: [] }
      const parsed = parseSecretGrants(grants)
      if (!parsed) return { ok: false, errors: [{ value: '', reason: 'invalid' }] }
      const known = new Map(deps.service.list(workspaceId).map((s) => [s.id, s]))
      const errors = parsed.flatMap((g) => {
        const secret = known.get(g.id)
        if (!secret) return [{ value: g.id, reason: 'unknown-secret' }]
        if (secret.source === 'browser' && g.mode !== 'request') {
          return [{ value: secret.name, reason: 'browser-secret' }]
        }
        return []
      })
      if (errors.length > 0) return { ok: false, errors }
      return {
        ok: true,
        settings: deps.sandboxes.update(workspaceId, ({ secrets: _old, ...rest }) =>
          parsed.length === 0 ? rest : { ...rest, secrets: parsed },
        ),
      }
    },
  )
}
