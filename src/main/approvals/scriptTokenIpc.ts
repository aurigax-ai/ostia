import { BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron'
import {
  type ScriptTokenSaveResult,
  type ScriptTokensState,
  tokenExpiry,
} from '../../shared/permissions/scriptTokens'
import { removeScript } from '../control/idRegistry'
import type { ReachListing } from './reach'
import {
  type PresenceRequest,
  checkUserPresence,
  createScriptToken,
  findScriptToken,
  listScriptTokens,
  parseTokenChanges,
  parseTokenRequest,
  regenerates,
  resolveScope,
  retiredScriptTokens,
  revokeScriptToken,
  updateScriptToken,
} from './scriptTokens'

export interface ScriptTokenIpcDeps {
  path: () => string
  retiredPath: () => string
  listing: () => Promise<ReachListing>
  changed: () => void
  appWindows: () => Iterable<BrowserWindow>
}

function refusal(err: unknown): ScriptTokenSaveResult {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

async function refusedPresence(request: PresenceRequest): Promise<ScriptTokenSaveResult | null> {
  const result = await checkUserPresence(request)
  if (result.ok) return null
  return {
    ok: false,
    error: `presence-${result.code}: ${result.detail}`,
    presence: result.hint ?? (result.code === 'cancelled' ? 'cancelled' : 'refused'),
  }
}

export async function scriptTokensState(deps: ScriptTokenIpcDeps): Promise<ScriptTokensState> {
  const listing = await deps.listing().catch((): ReachListing => ({ workspaces: [], groups: [] }))
  return {
    tokens: listScriptTokens(deps.path()),
    retired: retiredScriptTokens(deps.retiredPath()),
    workspaces: listing.workspaces.map((w) => ({
      id: w.workspaceId,
      name: w.name,
      ...(w.groupId ? { groupId: w.groupId } : {}),
    })),
    groups: listing.groups.map((g) => ({
      id: g.groupId,
      name: g.name,
      ...(typeof g.color === 'string' ? { color: g.color } : {}),
    })),
  }
}

export async function createFromSettings(
  deps: ScriptTokenIpcDeps,
  raw: unknown,
): Promise<ScriptTokenSaveResult> {
  try {
    const request = parseTokenRequest(raw)
    const scope = resolveScope(request.scope, await deps.listing())
    const expiresAt = tokenExpiry(request.expires, new Date())
    const refused = await refusedPresence({ action: 'generate', name: request.name })
    if (refused) return refused
    const { token: value, ...token } = createScriptToken(deps.path(), request.name, request.caps, {
      scope,
      expiresAt,
      source: 'settings',
    })
    deps.changed()
    return { ok: true, token, value }
  } catch (err) {
    return refusal(err)
  }
}

export async function updateFromSettings(
  deps: ScriptTokenIpcDeps,
  raw: unknown,
): Promise<ScriptTokenSaveResult> {
  try {
    const changes = parseTokenChanges(raw)
    const ifUpdatedAt =
      typeof raw === 'object' && raw !== null
        ? (raw as { ifUpdatedAt?: unknown }).ifUpdatedAt
        : undefined
    if (typeof ifUpdatedAt !== 'string') throw new Error('bad-request: ifUpdatedAt')
    const current = findScriptToken(deps.path(), changes.ref)
    if (current.id !== changes.ref) throw new Error(`unknown-token: ${changes.ref}`)
    if (current.updatedAt !== ifUpdatedAt) {
      throw new Error(`conflict: the script token "${current.name}" changed meanwhile; try again`)
    }
    const name = changes.name ?? current.name
    if (!regenerates(changes)) {
      const token = updateScriptToken(deps.path(), current.id, { name, ifUpdatedAt })
      deps.changed()
      return { ok: true, token }
    }
    const scope = changes.scope ? resolveScope(changes.scope, await deps.listing()) : current.scope
    const expiresAt =
      changes.expires === undefined ? current.expiresAt : tokenExpiry(changes.expires, new Date())
    const refused = await refusedPresence({ action: 'regenerate', name })
    if (refused) return refused
    const { token: value, ...token } = updateScriptToken(deps.path(), current.id, {
      name,
      caps: changes.caps ?? current.caps,
      scope,
      expiresAt,
      ifUpdatedAt,
    })
    deps.changed()
    return { ok: true, token, value }
  } catch (err) {
    return refusal(err)
  }
}

export function revokeFromSettings(deps: ScriptTokenIpcDeps, id: unknown): boolean {
  if (typeof id !== 'string' || !id || !revokeScriptToken(deps.path(), id)) return false
  removeScript(id)
  deps.changed()
  return true
}

export function fromAppWindow(deps: ScriptTokenIpcDeps, e: IpcMainInvokeEvent): boolean {
  if (!e.senderFrame || e.senderFrame !== e.sender.mainFrame) return false
  const win = BrowserWindow.fromWebContents(e.sender)
  return win !== null && [...deps.appWindows()].includes(win)
}

export function registerScriptTokenIpc(deps: ScriptTokenIpcDeps): void {
  const guarded =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (e: IpcMainInvokeEvent, ...args: A): R => {
      if (!fromAppWindow(deps, e)) {
        throw new Error('forbidden: script tokens are managed only from an Ostia window')
      }
      return fn(...args)
    }
  ipcMain.handle(
    'scriptTokens:list',
    guarded(() => scriptTokensState(deps)),
  )
  ipcMain.handle(
    'scriptTokens:create',
    guarded((input: unknown) => createFromSettings(deps, input)),
  )
  ipcMain.handle(
    'scriptTokens:update',
    guarded((input: unknown) => updateFromSettings(deps, input)),
  )
  ipcMain.handle(
    'scriptTokens:revoke',
    guarded((id: unknown) => revokeFromSettings(deps, id)),
  )
}
