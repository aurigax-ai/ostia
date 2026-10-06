import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import type { Capability } from '../shared/capabilities'
import { SCRIPT_CAPABILITIES, SCRIPT_TOKEN_PREFIX } from '../shared/scriptTokens'
import { ensureCaps } from './controlElevation'
import { registerControlMethod } from './controlServer'
import { removeScript } from './idRegistry'
import { loadJson, saveJson } from './jsonStore'

const NAME_MAX = 60

interface StoredToken {
  id: string
  name: string
  hash: string
  caps: Capability[]
  createdAt: string
}

export interface ScriptToken {
  id: string
  name: string
  caps: Capability[]
  createdAt: string
}

type TokenStore = Record<string, StoredToken>

function fail(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, message)
}

function hashOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function scriptCaps(raw: unknown): Capability[] {
  const held = Array.isArray(raw) ? raw : []
  return SCRIPT_CAPABILITIES.filter((cap) => held.includes(cap))
}

function load(path: string): TokenStore {
  const raw = loadJson<Record<string, Partial<StoredToken>>>(path, {})
  const store: TokenStore = {}
  for (const [id, t] of Object.entries(raw)) {
    if (typeof t?.hash !== 'string' || typeof t.name !== 'string') continue
    store[id] = {
      id,
      name: t.name,
      hash: t.hash,
      caps: scriptCaps(t.caps),
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : '',
    }
  }
  return store
}

function publicView(t: StoredToken): ScriptToken {
  return { id: t.id, name: t.name, caps: [...t.caps], createdAt: t.createdAt }
}

export function parseTokenRequest(raw: unknown): { name: string; caps: Capability[] } {
  const p = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const name = typeof p.name === 'string' ? p.name.trim() : ''
  if (!name || name.length > NAME_MAX || !/^[\w .@-]+$/.test(name)) {
    throw fail(`bad-request: name (1-${NAME_MAX} letters, digits, space, . _ @ -)`)
  }
  if (!Array.isArray(p.caps) || p.caps.length === 0) throw fail('bad-request: caps')
  const unknown = p.caps.filter((cap) => !SCRIPT_CAPABILITIES.includes(cap as Capability))
  if (unknown.length > 0) {
    throw fail(
      `bad-request: a script token can hold only ${SCRIPT_CAPABILITIES.join(', ')} (got ${unknown.join(', ')})`,
    )
  }
  return { name, caps: scriptCaps(p.caps) }
}

export function createScriptToken(
  path: string,
  name: string,
  caps: readonly Capability[],
): ScriptToken & { token: string } {
  const store = load(path)
  const token = `${SCRIPT_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`
  const stored: StoredToken = {
    id: `script_${randomUUID()}`,
    name,
    hash: hashOf(token),
    caps: scriptCaps(caps),
    createdAt: new Date().toISOString(),
  }
  store[stored.id] = stored
  saveJson(path, store, { secure: true })
  return { ...publicView(stored), token }
}

export function listScriptTokens(path: string): ScriptToken[] {
  return Object.values(load(path)).map(publicView)
}

export function revokeScriptToken(path: string, id: string): boolean {
  const store = load(path)
  if (!store[id]) return false
  delete store[id]
  saveJson(path, store, { secure: true })
  return true
}

export function verifyScriptToken(path: string, token: string): ScriptToken | undefined {
  if (!token.startsWith(SCRIPT_TOKEN_PREFIX)) return undefined
  const given = Buffer.from(hashOf(token), 'hex')
  for (const stored of Object.values(load(path))) {
    const known = Buffer.from(stored.hash, 'hex')
    if (known.length === given.length && timingSafeEqual(known, given)) return publicView(stored)
  }
  return undefined
}

export function registerScriptTokenMethods(path: () => string): void {
  registerControlMethod('token.create', {
    handler: async (raw, ctx) => {
      const { name, caps } = parseTokenRequest(raw)
      await ensureCaps(
        ctx.authed,
        ctx.identity,
        ['settings-write', ...caps],
        'token.create',
        `let scripts outside Ostia use the token "${name}" with ${caps.join(', ')}`,
      )
      return createScriptToken(path(), name, caps)
    },
  })

  registerControlMethod('token.list', {
    cap: 'settings-read',
    handler: () => listScriptTokens(path()),
  })

  registerControlMethod('token.revoke', {
    handler: async (raw, ctx) => {
      const id = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined
      if (typeof id !== 'string' || !id) throw fail('bad-request: id')
      await ensureCaps(ctx.authed, ctx.identity, ['settings-write'], 'token.revoke', id)
      if (!revokeScriptToken(path(), id)) throw fail(`unknown-token: ${id}`)
      removeScript(id)
      return { ok: true, id }
    },
  })
}
