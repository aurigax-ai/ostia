import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebStorageDump } from '../../shared/browseRuntime'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}))

const { BROWSE_WORLD_ID } = await import('./browseWorld')
const {
  clearStorage,
  readStorage,
  registerBrowserStorageIpc,
  removeStorage,
  toStorageCookie,
  writeStorage,
} = await import('./browserStorage')

const electronCookie = {
  name: 'sid',
  value: 'abc',
  domain: 'app.test',
  hostOnly: true,
  path: '/',
  secure: true,
  httpOnly: true,
  session: false,
  expirationDate: 2_000_000_000,
  sameSite: 'lax' as const,
}

class FakeGuest {
  scripts: string[] = []
  web: WebStorageDump = { origin: 'https://app.test', local: { b: '2', a: '1' }, session: {} }
  cookieStore = {
    get: vi.fn(async (_filter: unknown) => [electronCookie]),
    set: vi.fn(async (_details: unknown) => undefined),
    remove: vi.fn(async (_url: string, _name: string) => undefined),
  }
  session = {
    cookies: this.cookieStore,
    clearStorageData: vi.fn(async (_opts: unknown) => undefined),
  }
  executeJavaScriptInIsolatedWorld = vi.fn(async (worldId: number, scripts: { code: string }[]) => {
    expect(worldId).toBe(BROWSE_WORLD_ID)
    const code = scripts[0].code
    this.scripts.push(code.slice(code.lastIndexOf('\n') + 1))
    if (code.endsWith('storage()')) return this.web
    return { ok: true }
  })
}

function guest(): FakeGuest & Electron.WebContents {
  return new FakeGuest() as unknown as FakeGuest & Electron.WebContents
}

describe('toStorageCookie', () => {
  it('keeps the flags the viewer shows and turns a session cookie expiry into null', () => {
    expect(toStorageCookie(electronCookie as Electron.Cookie)).toEqual({
      name: 'sid',
      value: 'abc',
      domain: 'app.test',
      path: '/',
      hostOnly: true,
      expires: 2_000_000_000,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    })
    expect(
      toStorageCookie({ ...electronCookie, session: true } as Electron.Cookie).expires,
    ).toBeNull()
  })
})

describe('readStorage', () => {
  it('reads the partition cookies and the page origin web storage from the browse world', async () => {
    const g = guest()
    const snapshot = await readStorage(g)
    expect(g.cookieStore.get).toHaveBeenCalledWith({})
    expect(snapshot.origin).toBe('https://app.test')
    expect(snapshot.cookies.map((c) => c.name)).toEqual(['sid'])
    expect(snapshot.local).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
    ])
    expect(g.scripts).toEqual(['window.__ostiaBrowse.storage()'])
  })
})

describe('writeStorage', () => {
  it('sets a host-only cookie without a domain so it stays host-only', async () => {
    const g = guest()
    const cookie = toStorageCookie(electronCookie as Electron.Cookie)
    expect(await writeStorage(g, { kind: 'cookies', cookie: { ...cookie, value: 'new' } })).toEqual(
      { ok: true },
    )
    expect(g.cookieStore.set).toHaveBeenCalledWith({
      url: 'https://app.test/',
      name: 'sid',
      value: 'new',
      domain: undefined,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: 2_000_000_000,
    })
  })

  it('keeps the domain of a domain cookie', async () => {
    const g = guest()
    const cookie = { ...toStorageCookie(electronCookie as Electron.Cookie), hostOnly: false }
    await writeStorage(g, { kind: 'cookies', cookie: { ...cookie, domain: '.app.test' } })
    expect(g.cookieStore.set.mock.calls[0][0]).toMatchObject({
      url: 'https://app.test/',
      domain: '.app.test',
    })
  })

  it('writes web storage through the isolated browse world', async () => {
    const g = guest()
    await writeStorage(g, { kind: 'session', key: 'k', value: 'v' })
    expect(g.scripts).toEqual(['window.__ostiaBrowse.setStorage("session", "k", "v")'])
  })

  it('reports a failure instead of throwing', async () => {
    const g = guest()
    g.cookieStore.set.mockRejectedValueOnce(new Error('bad cookie'))
    const cookie = toStorageCookie(electronCookie as Electron.Cookie)
    expect(await writeStorage(g, { kind: 'cookies', cookie })).toEqual({
      ok: false,
      error: 'storage-failed',
      message: 'bad cookie',
    })
  })
})

describe('removeStorage and clearStorage', () => {
  it('removes a cookie by the url it belongs to', async () => {
    const g = guest()
    await removeStorage(g, {
      kind: 'cookies',
      cookie: { name: 'sid', domain: '.app.test', path: '/a', secure: false },
    })
    expect(g.cookieStore.remove).toHaveBeenCalledWith('http://app.test/a', 'sid')
  })

  it('removes and clears web storage entries', async () => {
    const g = guest()
    await removeStorage(g, { kind: 'local', key: 'a' })
    await clearStorage(g, 'session')
    expect(g.scripts).toEqual([
      'window.__ostiaBrowse.removeStorage("local", "a")',
      'window.__ostiaBrowse.clearStorage("session")',
    ])
  })

  it('clears the pane partition cookie jar', async () => {
    const g = guest()
    await clearStorage(g, 'cookies')
    expect(g.session.clearStorageData).toHaveBeenCalledWith({ storages: ['cookies'] })
  })
})

describe('registerBrowserStorageIpc', () => {
  const owned = guest()
  const lookup = vi.fn((paneId: string, windowId: string) =>
    paneId === 'p1' && windowId === '7' ? owned : null,
  )

  beforeEach(() => {
    handlers.clear()
    registerBrowserStorageIpc(lookup)
  })

  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)?.({ sender: { id: 7 } }, ...args)

  it('only serves panes the calling window owns', async () => {
    expect(await invoke('browser:storage-read', 'p2')).toEqual({
      ok: false,
      error: 'browser-not-ready',
    })
    const read = (await invoke('browser:storage-read', 'p1')) as { ok: boolean }
    expect(read.ok).toBe(true)
  })

  it('refuses edits that do not validate before touching the page', async () => {
    const before = owned.scripts.length
    expect(
      await invoke('browser:storage-set', 'p1', { kind: 'local', key: '', value: 'x' }),
    ).toEqual({ ok: false, error: 'invalid-entry' })
    expect(await invoke('browser:storage-clear', 'p1', 'indexeddb')).toEqual({
      ok: false,
      error: 'invalid-entry',
    })
    expect(owned.scripts.length).toBe(before)
  })

  it('applies a valid removal', async () => {
    expect(await invoke('browser:storage-remove', 'p1', { kind: 'local', key: 'a' })).toEqual({
      ok: true,
    })
  })
})
