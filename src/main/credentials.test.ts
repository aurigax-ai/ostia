import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: {},
  clipboard: {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
  safeStorage: {},
}))

const { createCredentialStore } = await import('./credentials')

function memoryStore(canEncrypt = true) {
  let saved: unknown[] = []
  let n = 0
  const store = createCredentialStore({
    load: () => structuredClone(saved) as never,
    save: (list) => {
      saved = structuredClone(list)
    },
    canEncrypt: () => canEncrypt,
    encrypt: (plain) => `enc:${plain}`,
    decrypt: (secret) => secret.replace(/^enc:/, ''),
    now: () => 1000,
    newId: () => `c${++n}`,
  })
  return { store, saved: () => saved }
}

describe('credential store', () => {
  it('stores passwords encrypted under the exact origin and lists them without passwords', () => {
    const { store, saved } = memoryStore()
    expect(
      store.save({ origin: 'https://github.com/login', username: 'me', password: 'pw' }),
    ).toEqual({ ok: true, id: 'c1', updated: false })

    expect(JSON.stringify(saved())).not.toContain('"pw"')
    expect(store.list()).toEqual([
      { id: 'c1', origin: 'https://github.com', username: 'me', updatedAt: 1000 },
    ])
    expect(store.password('c1')).toBe('pw')
  })

  it('updates the password of the same origin and username instead of adding a duplicate', () => {
    const { store } = memoryStore()
    store.save({ origin: 'https://github.com', username: 'me', password: 'old' })
    expect(store.save({ origin: 'https://github.com/', username: 'me', password: 'new' })).toEqual({
      ok: true,
      id: 'c1',
      updated: true,
    })
    expect(store.list()).toHaveLength(1)
    expect(store.password('c1')).toBe('new')
  })

  it('matches only the exact origin, never a look-alike host', () => {
    const { store } = memoryStore()
    store.save({ origin: 'https://github.com', username: 'me', password: 'pw' })
    expect(store.forOrigin('https://github.com/settings')).toHaveLength(1)
    expect(store.forOrigin('https://github.com.evil.io/login')).toEqual([])
    expect(store.forOrigin('http://github.com')).toEqual([])
  })

  it('refuses bad input and works only when encryption is available', () => {
    const { store } = memoryStore()
    expect(store.save({ origin: 'ftp://x', username: 'a', password: 'b' })).toEqual({
      ok: false,
      error: 'invalid-origin',
    })
    expect(store.save({ origin: 'https://x.dev', username: 'a', password: '' })).toEqual({
      ok: false,
      error: 'empty',
    })
    const locked = memoryStore(false).store
    expect(locked.save({ origin: 'https://x.dev', username: 'a', password: 'b' })).toEqual({
      ok: false,
      error: 'encryption-unavailable',
    })
  })

  it('imports rows, counting new, updated and skipped entries', () => {
    const { store } = memoryStore()
    store.save({ origin: 'https://a.dev', username: 'me', password: 'old' })
    expect(
      store.importRows([
        { origin: 'https://a.dev', username: 'me', password: 'new' },
        { origin: 'https://b.dev', username: 'me', password: 'pw' },
        { origin: 'not a url', username: 'me', password: 'pw' },
      ]),
    ).toEqual({ ok: true, imported: 1, updated: 1, skipped: 1 })
    expect(store.list().map((c) => c.origin)).toEqual(['https://a.dev', 'https://b.dev'])
  })

  it('removes an entry by id', () => {
    const { store } = memoryStore()
    store.save({ origin: 'https://a.dev', username: 'me', password: 'pw' })
    expect(store.remove('c1')).toBe(true)
    expect(store.remove('c1')).toBe(false)
    expect(store.list()).toEqual([])
  })
})
