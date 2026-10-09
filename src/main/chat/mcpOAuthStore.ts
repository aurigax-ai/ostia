import type { OAuthClientInformation, OAuthTokens } from '@ai-sdk/mcp'
import { isDangerousSegment } from '../../shared/protoGuard'
import { type SecretStoreDeps, sanitizeSecrets } from '../extensions/extensionSecrets'

export const MCP_OAUTH_KEY = 'oauth:session'
export const MCP_OAUTH_RECORD_MAX = 64 * 1024

export interface McpOAuthRecord {
  url: string
  redirectUrl: string
  client: OAuthClientInformation
  tokens?: OAuthTokens
  expiresAt?: number
}

export interface McpOAuthStore {
  get: (server: string, url: string) => McpOAuthRecord | null
  set: (server: string, record: McpOAuthRecord) => { ok: true } | { ok: false; error: string }
  clear: (server: string) => void
  prune: (servers: { name: string; url?: string }[]) => void
  canStore: () => boolean
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parseRecord(text: string): McpOAuthRecord | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw) || typeof raw.url !== 'string' || typeof raw.redirectUrl !== 'string') {
    return null
  }
  if (!isObject(raw.client) || typeof raw.client.client_id !== 'string') return null
  const record: McpOAuthRecord = {
    url: raw.url,
    redirectUrl: raw.redirectUrl,
    client: raw.client as OAuthClientInformation,
  }
  if (
    isObject(raw.tokens) &&
    typeof raw.tokens.access_token === 'string' &&
    typeof raw.tokens.token_type === 'string'
  ) {
    record.tokens = raw.tokens as OAuthTokens
    if (typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt)) {
      record.expiresAt = raw.expiresAt
    }
  }
  return record
}

export function createMcpOAuthStore(deps: SecretStoreDeps): McpOAuthStore {
  const cache = new Map<string, McpOAuthRecord | null>()

  const remove = (servers: string[]): void => {
    const data = sanitizeSecrets(deps.load())
    let changed = false
    for (const server of servers) {
      cache.delete(server)
      const values = data[server]
      if (!values || !(MCP_OAUTH_KEY in values)) continue
      delete values[MCP_OAUTH_KEY]
      if (Object.keys(values).length === 0) delete data[server]
      changed = true
    }
    if (changed) deps.save({ ...data })
  }

  const read = (server: string): McpOAuthRecord | null => {
    const cached = cache.get(server)
    if (cached !== undefined) return cached
    if (!deps.canEncrypt()) return null
    const stored = sanitizeSecrets(deps.load())[server]?.[MCP_OAUTH_KEY]
    let record: McpOAuthRecord | null = null
    if (stored !== undefined) {
      try {
        record = parseRecord(deps.decrypt(stored))
      } catch {
        record = null
      }
    }
    cache.set(server, record)
    return record
  }

  return {
    canStore: () => deps.canEncrypt(),
    get: (server, url) => {
      const record = read(server)
      if (!record) return null
      if (record.url === url) return record
      remove([server])
      return null
    },
    set: (server, record) => {
      if (isDangerousSegment(server)) return { ok: false, error: 'invalid-key' }
      if (!deps.canEncrypt()) return { ok: false, error: 'encryption-unavailable' }
      const text = JSON.stringify(record)
      if (text.length > MCP_OAUTH_RECORD_MAX) return { ok: false, error: 'invalid-value' }
      const data = sanitizeSecrets(deps.load())
      data[server] = { ...(data[server] ?? {}), [MCP_OAUTH_KEY]: deps.encrypt(text) }
      deps.save({ ...data })
      cache.set(server, parseRecord(text))
      return { ok: true }
    },
    clear: (server) => remove([server]),
    prune: (servers) => {
      const urls = new Map(servers.map((s) => [s.name, s.url]))
      const data = sanitizeSecrets(deps.load())
      const stale: string[] = []
      for (const [server, values] of Object.entries(data)) {
        if (!(MCP_OAUTH_KEY in values)) continue
        if (!urls.has(server)) stale.push(server)
        else if (deps.canEncrypt() && read(server)?.url !== urls.get(server)) stale.push(server)
      }
      if (stale.length > 0) remove(stale)
    },
  }
}
