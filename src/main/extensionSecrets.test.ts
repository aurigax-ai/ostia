import { describe, expect, it } from 'vitest'
import { type SecretStoreDeps, createSecretStore } from './extensionSecrets'

function fakeDeps(canEncrypt = true): SecretStoreDeps & { data: () => unknown } {
  let data: unknown = {}
  return {
    data: () => data,
    load: () => data,
    save: (next) => {
      data = JSON.parse(JSON.stringify(next))
    },
    canEncrypt: () => canEncrypt,
    encrypt: (plain) => Buffer.from(`x${plain}`).toString('base64'),
    decrypt: (secret) => Buffer.from(secret, 'base64').toString().slice(1),
  }
}

describe('createSecretStore', () => {
  it('stores only the encrypted form and returns the plain value to the owner', () => {
    const deps = fakeDeps()
    const store = createSecretStore(deps)
    expect(store.set('assistant', 'apiKey', 'sk-live-1')).toEqual({ ok: true })
    expect(JSON.stringify(deps.data())).not.toContain('sk-live-1')
    expect(store.get('assistant', 'apiKey')).toBe('sk-live-1')
    expect(store.get('other', 'apiKey')).toBeNull()
    expect(store.keys('assistant')).toEqual(['apiKey'])
  })

  it('clears a key and drops an extension with no secrets left', () => {
    const deps = fakeDeps()
    const store = createSecretStore(deps)
    store.set('assistant', 'apiKey', 'k')
    expect(store.set('assistant', 'apiKey', null)).toEqual({ ok: true })
    expect(store.keys('assistant')).toEqual([])
    expect(deps.data()).toEqual({})
  })

  it('refuses to store when encryption is unavailable', () => {
    const deps = fakeDeps(false)
    const store = createSecretStore(deps)
    expect(store.set('assistant', 'apiKey', 'k')).toEqual({
      ok: false,
      error: 'encryption-unavailable',
    })
    expect(deps.data()).toEqual({})
  })

  it('refuses empty or oversized values and prototype keys', () => {
    const store = createSecretStore(fakeDeps())
    expect(store.set('assistant', 'apiKey', '')).toEqual({ ok: false, error: 'invalid-value' })
    expect(store.set('assistant', 'apiKey', 'k'.repeat(5000))).toEqual({
      ok: false,
      error: 'invalid-value',
    })
    expect(store.set('__proto__', 'apiKey', 'k')).toEqual({ ok: false, error: 'invalid-key' })
  })

  it('ignores garbage in the stored file', () => {
    const deps = fakeDeps()
    deps.save({ assistant: { apiKey: 42, ok: Buffer.from('xv').toString('base64') } } as never)
    const store = createSecretStore(deps)
    expect(store.keys('assistant')).toEqual(['ok'])
    expect(store.get('assistant', 'apiKey')).toBeNull()
  })
})
