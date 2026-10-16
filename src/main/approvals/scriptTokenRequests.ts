import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import {
  DEFAULT_TOKEN_EXPIRY,
  NEVER_EXPIRES,
  SCRIPT_CAPABILITIES,
  type ScriptTokenScope,
  tokenExpiry,
} from '../../shared/permissions/scriptTokens'
import type { ReachListing } from './reach'

const NAME_MAX = 60

export function fail(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, message)
}

export function heldCaps(raw: unknown): Capability[] {
  const held = Array.isArray(raw) ? raw : []
  return SCRIPT_CAPABILITIES.filter((cap) => cap !== 'all-workspaces' && held.includes(cap))
}

export function ids(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string' && v)) return undefined
  return [...new Set(raw as string[])]
}

function cleanTokenName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name || name.length > NAME_MAX || !/^[\w .@-]+$/.test(name)) {
    throw fail(`bad-request: name (1-${NAME_MAX} letters, digits, space, . _ @ -)`)
  }
  return name
}

function cleanCaps(raw: unknown): Capability[] {
  if (!Array.isArray(raw) || raw.length === 0) throw fail('bad-request: caps')
  const unknown = raw.filter((cap) => !SCRIPT_CAPABILITIES.includes(cap as Capability))
  if (unknown.length > 0) {
    throw fail(
      `bad-request: a script token can hold only ${SCRIPT_CAPABILITIES.join(', ')} (got ${unknown.join(', ')})`,
    )
  }
  return SCRIPT_CAPABILITIES.filter((cap) => raw.includes(cap))
}

function cleanExpires(raw: unknown, confirmNever: unknown): string {
  if (typeof raw !== 'string' || !raw) throw fail('bad-request: expires')
  if (raw === NEVER_EXPIRES && confirmNever !== true) {
    throw fail('bad-request: expires never needs confirmNeverExpires: true')
  }
  try {
    tokenExpiry(raw, new Date())
  } catch (err) {
    throw fail(`bad-request: ${(err as Error).message}`)
  }
  return raw
}

export type ScopeRequest =
  | { kind: 'all' }
  | { kind: 'limited'; groups: string[]; workspaces: string[]; ownWorkspaces: boolean }

function cleanScope(raw: unknown, caps: readonly Capability[]): ScopeRequest | undefined {
  const reachAll = caps.includes('all-workspaces')
  if (raw === undefined) return reachAll ? { kind: 'all' } : undefined
  const s = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  if (s.kind === 'all') return { kind: 'all' }
  const groups = s.groups === undefined ? [] : ids(s.groups)
  const workspaces = s.workspaces === undefined ? [] : ids(s.workspaces)
  if (s.kind !== 'limited' || !groups || !workspaces || groups.length + workspaces.length === 0) {
    throw fail('bad-request: scope (all, or at least one group or workspace)')
  }
  if (reachAll) throw fail('bad-request: all-workspaces needs the scope all')
  return { kind: 'limited', groups, workspaces, ownWorkspaces: s.ownWorkspaces === true }
}

export interface TokenRequest {
  name: string
  caps: Capability[]
  scope: ScopeRequest
  expires: string
}

export function parseTokenRequest(raw: unknown): TokenRequest {
  const p = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const name = cleanTokenName(p.name)
  const caps = cleanCaps(p.caps)
  const scope = cleanScope(p.scope, caps)
  if (!scope) {
    throw fail('bad-request: scope (pass --scope all, group:<name|id> or workspace:<name|id>)')
  }
  const expires =
    p.expires === undefined ? DEFAULT_TOKEN_EXPIRY : cleanExpires(p.expires, p.confirmNeverExpires)
  return { name, caps: heldCaps(caps), scope, expires }
}

export interface TokenChanges {
  ref: string
  name?: string
  caps?: Capability[]
  scope?: ScopeRequest
  expires?: string
  confirmNeverExpires?: true
}

export function parseTokenChanges(raw: unknown): TokenChanges {
  const p = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  if (typeof p.id !== 'string' || !p.id) throw fail('bad-request: id')
  const changes: TokenChanges = { ref: p.id }
  if (p.name !== undefined) changes.name = cleanTokenName(p.name)
  const caps = p.caps === undefined ? undefined : cleanCaps(p.caps)
  if (caps) changes.caps = heldCaps(caps)
  const scope = cleanScope(p.scope, caps ?? [])
  if (scope) changes.scope = scope
  if (p.expires !== undefined) changes.expires = cleanExpires(p.expires, p.confirmNeverExpires)
  if (Object.keys(changes).length === 1) {
    throw fail('bad-request: nothing to change (name, caps, scope or expires)')
  }
  if (p.confirmNeverExpires === true) changes.confirmNeverExpires = true
  return changes
}

export function confirmStillNever(
  changes: TokenChanges,
  expiresAt: string | null,
  name: string,
): void {
  if (expiresAt === null && changes.confirmNeverExpires !== true) {
    throw fail(
      `bad-request: the script token "${name}" never expires, so regenerating it needs confirmNeverExpires: true (ostia token update --yes-never-expires)`,
    )
  }
}

export function regenerates(changes: TokenChanges): boolean {
  return changes.caps !== undefined || changes.scope !== undefined || changes.expires !== undefined
}

function resolveRef(ref: string, entries: { id: string; name: string }[], kind: string): string {
  if (entries.some((e) => e.id === ref)) return ref
  const named = entries.filter((e) => e.name === ref)
  if (named.length > 1) throw fail(`ambiguous-${kind}: ${ref} (pass its id)`)
  if (named.length === 0) throw fail(`unknown-${kind}: ${ref}`)
  return named[0].id
}

export function resolveScope(request: ScopeRequest, listing: ReachListing): ScriptTokenScope {
  if (request.kind === 'all') return { kind: 'all' }
  const groups = listing.groups.map((g) => ({ id: g.groupId, name: g.name }))
  const workspaces = listing.workspaces.map((w) => ({ id: w.workspaceId, name: w.name }))
  return {
    kind: 'limited',
    groups: [...new Set(request.groups.map((ref) => resolveRef(ref, groups, 'group')))],
    workspaces: [
      ...new Set(request.workspaces.map((ref) => resolveRef(ref, workspaces, 'workspace'))),
    ],
    ownWorkspaces: request.ownWorkspaces,
  }
}
