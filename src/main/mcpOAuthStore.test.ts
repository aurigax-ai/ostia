import { describe, expect, it } from 'vitest'
import { type StoredSecrets, createSecretStore } from './extensionSecrets'
import {
  MCP_OAUTH_KEY,
  MCP_OAUTH_RECORD_MAX,
  type McpOAuthRecord,
  createMcpOAuthStore,
} from './mcpOAuthStore'

function file(initial: StoredSecrets = {}) {
  const state = { data: initial as unknown, unlocked: true, saves: 0 }
  const deps = {
    load: () => state.data,
    save: (data: StoredSecrets) => {
      state.saves += 1
      state.data = JSON.parse(JSON.stringify(data))
    },
    canEncrypt: () => state.unlocked,
    encrypt: (plain: string) => Buffer.from(`enc:${plain}`).toString('base64'),
    decrypt: (secret: string) => {
      const plain = Buffer.from(secret, 'base64').toString()
      if (!plain.startsWith('enc:')) throw new Error('not encrypted')
      return plain.slice(4)
    },
  }
  return { state, deps, data: () => state.data as StoredSecrets }
}

const record: McpOAuthRecord = {
  url: 'https://mcp.example.com/mcp',
  redirectUrl: 'http://127.0.0.1:4100/callback',
  client: { client_id: 'client-1' },
  tokens: { access_token: 'access-1', token_type: 'Bearer', refresh_token: 'refresh-1' },
  expiresAt: 1_800_000_000_000,
}

describe('createMcpOAuthStore', () => {
  it('keeps the session encrypted beside the header secrets of the same server', () => {
    const f = file()
    const secrets = createSecretStore(f.deps)
    const store = createMcpOAuthStore(f.deps)
    secrets.set('remote', 'X-Api-Key', 'key-1')
    expect(store.set('remote', record)).toEqual({ ok: true })
    secrets.set('remote', 'X-Other', 'key-2')

    expect(Object.keys(f.data().remote).sort()).toEqual(['X-Api-Key', 'X-Other', MCP_OAUTH_KEY])
    expect(JSON.stringify(f.data())).not.toContain('access-1')
    expect(JSON.stringify(f.data())).not.toContain('refresh-1')
    expect(createMcpOAuthStore(f.deps).get('remote', record.url)).toEqual(record)
    expect(secrets.get('remote', 'X-Api-Key')).toBe('key-1')
  })

  it('drops the session when the server URL is no longer the one that signed in', () => {
    const f = file()
    const store = createMcpOAuthStore(f.deps)
    store.set('remote', record)
    expect(store.get('remote', 'https://other.example.com/mcp')).toBeNull()
    expect(f.data()).toEqual({})
    expect(store.get('remote', record.url)).toBeNull()
  })

  it('prunes sessions of removed or re-pointed servers and leaves header secrets', () => {
    const f = file()
    const secrets = createSecretStore(f.deps)
    const store = createMcpOAuthStore(f.deps)
    for (const name of ['kept', 'moved', 'gone']) store.set(name, record)
    secrets.set('gone', 'X-Api-Key', 'key-1')
    store.prune([
      { name: 'kept', url: record.url },
      { name: 'moved', url: 'https://moved.example.com/mcp' },
    ])
    expect(Object.keys(f.data()).sort()).toEqual(['gone', 'kept'])
    expect(Object.keys(f.data().gone)).toEqual(['X-Api-Key'])
    expect(store.get('kept', record.url)).toEqual(record)
  })

  it('writes nothing when there is nothing to prune', () => {
    const f = file()
    const store = createMcpOAuthStore(f.deps)
    store.set('kept', record)
    const saves = f.state.saves
    store.prune([{ name: 'kept', url: record.url }])
    store.clear('unknown')
    expect(f.state.saves).toBe(saves)
  })

  it('refuses to store without encryption and keeps a session it cannot read while locked', () => {
    const f = file()
    const store = createMcpOAuthStore(f.deps)
    f.state.unlocked = false
    expect(store.canStore()).toBe(false)
    expect(store.set('remote', record)).toEqual({ ok: false, error: 'encryption-unavailable' })
    f.state.unlocked = true
    store.set('remote', record)
    const locked = createMcpOAuthStore(f.deps)
    f.state.unlocked = false
    expect(locked.get('remote', record.url)).toBeNull()
    locked.prune([{ name: 'remote', url: record.url }])
    f.state.unlocked = true
    expect(locked.get('remote', record.url)).toEqual(record)
  })

  it('refuses an oversized record, a dangerous name and ignores a damaged entry', () => {
    const f = file()
    const store = createMcpOAuthStore(f.deps)
    const huge = {
      ...record,
      tokens: { access_token: 'a'.repeat(MCP_OAUTH_RECORD_MAX), token_type: 'Bearer' },
    }
    expect(store.set('remote', huge)).toEqual({ ok: false, error: 'invalid-value' })
    expect(store.set('__proto__', record)).toEqual({ ok: false, error: 'invalid-key' })
    f.state.data = {
      plain: { [MCP_OAUTH_KEY]: 'not-base64-of-ours' },
      shapeless: { [MCP_OAUTH_KEY]: f.deps.encrypt('{"url":"https://mcp.example.com/mcp"}') },
    }
    const fresh = createMcpOAuthStore(f.deps)
    expect(fresh.get('plain', record.url)).toBeNull()
    expect(fresh.get('shapeless', record.url)).toBeNull()
  })

  it('keeps the registration but no tokens for a lapsed session', () => {
    const f = file()
    const store = createMcpOAuthStore(f.deps)
    store.set('remote', { url: record.url, redirectUrl: record.redirectUrl, client: record.client })
    expect(createMcpOAuthStore(f.deps).get('remote', record.url)).toEqual({
      url: record.url,
      redirectUrl: record.redirectUrl,
      client: record.client,
    })
  })
})
