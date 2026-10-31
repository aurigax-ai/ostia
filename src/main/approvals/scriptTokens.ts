import { hash, randomBytes, randomUUID } from 'node:crypto'
import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import {
  DEFAULT_TOKEN_EXPIRY,
  SCRIPT_TOKEN_PREFIX,
  type ScriptTokenInfo,
  type ScriptTokenScope,
  type ScriptTokenSource,
  type ScriptTokenUsage,
  tokenExpiry,
} from '../../shared/permissions/scriptTokens'
import { registerControlMethod } from '../control/controlServer'
import { removeScript } from '../control/idRegistry'
import { loadJson, saveJson } from '../platform/jsonStore'
import { sameBytes } from '../platform/sameBytes'
import { ensureCaps } from './controlElevation'
import type { ReachListing } from './reach'
import {
  approvalCaps,
  confirmUserPresence,
  describeExpiry,
  describeScope,
} from './scriptTokenConfirm'
import {
  confirmStillNever,
  fail,
  heldCaps,
  ids,
  parseTokenChanges,
  parseTokenRequest,
  regenerates,
  resolveScope,
} from './scriptTokenRequests'
import { type ScriptTokenUsageLog, type UsageLookups, usageView } from './scriptTokenUsage'

const LAST_USED_EVERY_MS = 60_000

type TokenSource = ScriptTokenSource

interface StoredToken {
  id: string
  name: string
  hash: string
  caps: Capability[]
  scope: ScriptTokenScope
  created: string[]
  createdAt: string
  updatedAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  source: TokenSource
}

export type ScriptToken = ScriptTokenInfo

export interface ScriptTokenPaths {
  path: string
}

export interface ScriptTokenScopeView {
  scope: ScriptTokenScope
  created: string[]
}

type TokenStore = Record<string, StoredToken>

function hashOf(token: string): string {
  return hash('sha256', token)
}

function newToken(): string {
  return `${SCRIPT_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`
}

function storedScope(raw: unknown): ScriptTokenScope | undefined {
  const s = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  if (s.kind === 'all') return { kind: 'all' }
  const groups = ids(s.groups)
  const workspaces = ids(s.workspaces)
  if (s.kind !== 'limited' || !groups || !workspaces) return undefined
  return { kind: 'limited', groups, workspaces, ownWorkspaces: s.ownWorkspaces === true }
}

function isoOrNull(raw: unknown): string | null {
  return typeof raw === 'string' && !Number.isNaN(Date.parse(raw)) ? raw : null
}

function load(path: string): TokenStore {
  const raw = loadJson<Record<string, Record<string, unknown>>>(path, {})
  const store: TokenStore = {}
  for (const [id, t] of Object.entries(raw)) {
    const scope = storedScope(t?.scope)
    if (typeof t?.hash !== 'string' || typeof t.name !== 'string' || !scope) continue
    if (t.expiresAt !== null && isoOrNull(t.expiresAt) === null) continue
    const createdAt = typeof t.createdAt === 'string' ? t.createdAt : ''
    store[id] = {
      id,
      name: t.name,
      hash: t.hash,
      caps: heldCaps(t.caps),
      scope,
      created: ids(t.created) ?? [],
      createdAt,
      updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : createdAt,
      expiresAt: isoOrNull(t.expiresAt),
      lastUsedAt: isoOrNull(t.lastUsedAt),
      source: t.source === 'settings' ? 'settings' : 'cli',
    }
  }
  return store
}

function save(path: string, store: TokenStore): void {
  saveJson(path, store, { secure: true })
}

function publicView(t: StoredToken): ScriptToken {
  return {
    id: t.id,
    name: t.name,
    caps: [...t.caps],
    scope: structuredClone(t.scope),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    source: t.source,
  }
}

function expired(t: Pick<StoredToken, 'expiresAt'>, now: Date): boolean {
  return t.expiresAt !== null && Date.parse(t.expiresAt) <= now.getTime()
}

function matching<T extends { hash: string }>(entries: Iterable<T>, token: string): T | undefined {
  if (!token.startsWith(SCRIPT_TOKEN_PREFIX)) return undefined
  const given = Buffer.from(hashOf(token), 'hex')
  for (const entry of entries) if (sameBytes(Buffer.from(entry.hash, 'hex'), given)) return entry
  return undefined
}

function findIn(store: TokenStore, ref: string): StoredToken {
  if (store[ref]) return store[ref]
  const named = Object.values(store).filter((t) => t.name === ref)
  if (named.length > 1) throw fail(`ambiguous-token: ${ref} (pass its id from ostia token list)`)
  if (named.length === 0) throw fail(`unknown-token: ${ref}`)
  return named[0]
}

export interface ScriptTokenOptions {
  scope?: ScriptTokenScope
  expiresAt?: string | null
  source?: TokenSource
}

export function createScriptToken(
  path: string,
  name: string,
  caps: readonly Capability[],
  options: ScriptTokenOptions = {},
  now = new Date(),
): ScriptToken & { token: string } {
  const store = load(path)
  const token = newToken()
  const at = now.toISOString()
  const scope: ScriptTokenScope =
    options.scope ??
    (caps.includes('all-workspaces')
      ? { kind: 'all' }
      : { kind: 'limited', groups: [], workspaces: [], ownWorkspaces: false })
  const stored: StoredToken = {
    id: `script_${randomUUID()}`,
    name,
    hash: hashOf(token),
    caps: heldCaps(caps),
    scope,
    created: [],
    createdAt: at,
    updatedAt: at,
    expiresAt:
      options.expiresAt === undefined ? tokenExpiry(DEFAULT_TOKEN_EXPIRY, now) : options.expiresAt,
    lastUsedAt: null,
    source: options.source ?? 'cli',
  }
  store[stored.id] = stored
  save(path, store)
  return { ...publicView(stored), token }
}

export interface ScriptTokenUpdate {
  name?: string
  caps?: readonly Capability[]
  scope?: ScriptTokenScope
  expiresAt?: string | null
  ifUpdatedAt?: string
}

export function updateScriptToken(
  path: string,
  ref: string,
  update: ScriptTokenUpdate,
  now = new Date(),
): ScriptToken & { token?: string } {
  const store = load(path)
  const stored = findIn(store, ref)
  if (update.ifUpdatedAt !== undefined && stored.updatedAt !== update.ifUpdatedAt) {
    throw fail(`conflict: the script token "${stored.name}" changed meanwhile; try again`)
  }
  if (update.name !== undefined) stored.name = update.name
  const regenerate =
    update.caps !== undefined || update.scope !== undefined || update.expiresAt !== undefined
  let token: string | undefined
  if (regenerate) {
    if (update.caps !== undefined) stored.caps = heldCaps(update.caps)
    if (update.scope !== undefined) stored.scope = update.scope
    if (update.expiresAt !== undefined) stored.expiresAt = update.expiresAt
    token = newToken()
    stored.hash = hashOf(token)
  }
  stored.updatedAt = now.toISOString()
  save(path, store)
  if (regenerate) removeScript(stored.id)
  return token ? { ...publicView(stored), token } : publicView(stored)
}

export function findScriptToken(path: string, ref: string): ScriptToken {
  return publicView(findIn(load(path), ref))
}

export function listScriptTokens(path: string): ScriptToken[] {
  return Object.values(load(path)).map(publicView)
}

export function revokeScriptToken(path: string, id: string): boolean {
  const store = load(path)
  if (!store[id]) return false
  delete store[id]
  save(path, store)
  return true
}

export function scriptTokenScope(path: string, id: string): ScriptTokenScopeView | undefined {
  const stored = load(path)[id]
  return stored ? { scope: stored.scope, created: [...stored.created] } : undefined
}

export function recordCreatedWorkspace(path: string, id: string, workspaceId: string): void {
  const store = load(path)
  const stored = store[id]
  if (!stored || stored.created.includes(workspaceId)) return
  stored.created.push(workspaceId)
  save(path, store)
}

const lastWritten = new Map<string, number>()

function touch(path: string, stored: StoredToken, now: Date): void {
  const last = lastWritten.get(stored.id)
  if (last !== undefined && now.getTime() - last < LAST_USED_EVERY_MS) return
  lastWritten.set(stored.id, now.getTime())
  const store = load(path)
  if (!store[stored.id]) return
  store[stored.id].lastUsedAt = now.toISOString()
  save(path, store)
}

export interface AuthenticatedScript {
  id: string
  caps: Capability[]
  expiresAt: string | null
}

export function checkScriptToken(
  paths: ScriptTokenPaths,
  token: string,
  now = new Date(),
): AuthenticatedScript | undefined {
  const stored = matching(Object.values(load(paths.path)), token)
  if (stored && expired(stored, now)) {
    throw fail(
      `token-expired: the script token "${stored.name}" expired at ${stored.expiresAt}; regenerate it with ostia token update ${stored.id} --expires <when>`,
    )
  }
  if (stored) {
    touch(paths.path, stored, now)
    const caps: Capability[] =
      stored.scope.kind === 'all' ? [...stored.caps, 'all-workspaces'] : [...stored.caps]
    return { id: stored.id, caps, expiresAt: stored.expiresAt }
  }
  return undefined
}

export interface ScriptTokenDeps {
  path: () => string
  listing: () => Promise<ReachListing>
  changed?: () => void
  usage?: ScriptTokenUsageLog
  panes?: UsageLookups['panes']
}

export async function scriptTokenUsage(
  deps: ScriptTokenDeps,
  ref: string,
  withNames: boolean,
): Promise<{ token: ScriptToken; usage: ScriptTokenUsage }> {
  const token = findScriptToken(deps.path(), ref)
  const usage = deps.usage
    ? await usageView(deps.usage, token.id, withNames ? deps : null)
    : {
        calls: [],
        connections: [],
        last24h: { calls: 0, refused: 0 },
        names: { workspaces: {}, panes: {} },
      }
  return { token, usage }
}

export function registerScriptTokenMethods(deps: ScriptTokenDeps): void {
  const changed = <T>(result: T): T => {
    deps.changed?.()
    return result
  }
  registerControlMethod('token.create', {
    handler: async (raw, ctx) => {
      const request = parseTokenRequest(raw)
      const scope = resolveScope(request.scope, await deps.listing())
      const expiresAt = tokenExpiry(request.expires, new Date())
      await ensureCaps(
        ctx.authed,
        ctx.identity,
        approvalCaps(request.caps, scope),
        'token.create',
        `let scripts outside Ostia use the token "${request.name}" with ${request.caps.join(', ') || 'no capability'} on ${describeScope(scope)}; it ${describeExpiry(expiresAt)}`,
      )
      await confirmUserPresence({ action: 'generate', name: request.name })
      return changed(
        createScriptToken(deps.path(), request.name, request.caps, {
          scope,
          expiresAt,
          source: 'cli',
        }),
      )
    },
  })

  registerControlMethod('token.update', {
    handler: async (raw, ctx) => {
      const changes = parseTokenChanges(raw)
      const current = findScriptToken(deps.path(), changes.ref)
      const name = changes.name ?? current.name
      if (!regenerates(changes)) {
        await ensureCaps(
          ctx.authed,
          ctx.identity,
          ['settings-write'],
          'token.update',
          `rename the script token "${current.name}" to "${name}"`,
        )
        return changed(
          updateScriptToken(deps.path(), current.id, {
            name,
            ifUpdatedAt: current.updatedAt,
          }),
        )
      }
      const caps = changes.caps ?? current.caps
      const scope = changes.scope
        ? resolveScope(changes.scope, await deps.listing())
        : current.scope
      const expiresAt =
        changes.expires === undefined ? current.expiresAt : tokenExpiry(changes.expires, new Date())
      confirmStillNever(changes, expiresAt, name)
      await ensureCaps(
        ctx.authed,
        ctx.identity,
        approvalCaps(caps, scope),
        'token.update',
        `regenerate the script token "${name}" with ${caps.join(', ') || 'no capability'} on ${describeScope(scope)}; it ${describeExpiry(expiresAt)}. The old value stops working at once`,
      )
      await confirmUserPresence({ action: 'regenerate', name })
      const updated = updateScriptToken(deps.path(), current.id, {
        name,
        caps,
        scope,
        expiresAt,
        ifUpdatedAt: current.updatedAt,
      })
      deps.usage?.regenerated(current.id)
      return changed(updated)
    },
  })

  registerControlMethod('token.list', {
    cap: 'settings-read',
    handler: () => listScriptTokens(deps.path()),
  })

  registerControlMethod('token.usage', {
    cap: 'settings-read',
    handler: (raw) => {
      const ref = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined
      if (typeof ref !== 'string' || !ref) throw fail('bad-request: id')
      return scriptTokenUsage(deps, ref, false)
    },
  })

  registerControlMethod('token.revoke', {
    handler: async (raw, ctx) => {
      const ref = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined
      if (typeof ref !== 'string' || !ref) throw fail('bad-request: id')
      await ensureCaps(ctx.authed, ctx.identity, ['settings-write'], 'token.revoke', ref)
      const { id } = findScriptToken(deps.path(), ref)
      revokeScriptToken(deps.path(), id)
      removeScript(id)
      deps.usage?.clear(id)
      return changed({ ok: true, id })
    },
  })
}
