import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAccountsState } from '../../../shared/claudeAccounts/claudeAccounts'
import { type AccountLogin, createProfile } from './accountProfiles'
import { ClaudeAccountsStore } from './accountsStore'
import { ClaudeAccounts } from './claudeAccounts'

let base: string
let root: string
let home: string
let store: ClaudeAccountsStore
let emails: Map<string, string>
let uuids: Map<string, string>
let defaultLogin: AccountLogin | null
let opened: string[]
let openResult: string | null
let published: ClaudeAccountsState[]
let accounts: ClaudeAccounts
let synced: string[]
let running: Set<string>
const TARGET = { workspaceId: 'ws-1', windowId: '1' }

function dirOf(index = 0): string {
  return opened[index].replace(/^.*CLAUDE_CONFIG_DIR=/, '')
}

function signIn(dir: string, email: string, uuid?: string): void {
  writeFileSync(join(dir, '.credentials.json'), 'x')
  emails.set(dir, email)
  if (uuid) uuids.set(dir, uuid)
}

beforeEach(() => {
  vi.useFakeTimers()
  base = mkdtempSync(join(tmpdir(), 'ostia-accounts-'))
  root = join(base, 'claude-accounts')
  home = join(base, 'dot-claude')
  mkdirSync(home)
  store = new ClaudeAccountsStore(join(base, 'claude-accounts.json'))
  emails = new Map()
  uuids = new Map()
  defaultLogin = { uuid: null, email: 'me@example.com' }
  opened = []
  openResult = 'pane-ext-1'
  published = []
  synced = []
  running = new Set()
  accounts = new ClaudeAccounts({
    store,
    root,
    defaultHome: () => home,
    defaultLogin: async () => defaultLogin,
    profileLogin: async (dir) =>
      emails.has(dir) ? { uuid: uuids.get(dir) ?? null, email: emails.get(dir) as string } : null,
    loginState: async () => 'signed-in',
    writeLogin: async () => true,
    signIn: null,
    usage: null,
    syncProfile: async (dir) => {
      synced.push(dir)
    },
    agentRunning: (paneId) => running.has(paneId),
    paneOf: (id) => id,
    openLoginTab: async (dir) => {
      opened.push(`CLAUDE_CONFIG_DIR=${dir}`)
      return openResult
    },
    onChange: (state) => published.push(state),
    pollMs: 1000,
    timeoutMs: 60_000,
    duplicateMs: 5000,
  })
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(base, { recursive: true, force: true })
})

describe('state', () => {
  it('lists the default account first, then the added ones', async () => {
    store.add({ id: 'a'.repeat(16), email: 'work@example.com', addedAt: 1 })
    const state = await accounts.state()
    expect(state.accounts.map((a) => a.email)).toEqual(['me@example.com', 'work@example.com'])
    expect(state.current).toBe('default')
    expect(state.adding).toBe(false)
  })
})

describe('usage', () => {
  const WORK_ID = 'a'.repeat(16)
  const OUT_ID = 'b'.repeat(16)
  const checked = {
    session: { percent: 42, resetsAt: 2 },
    weekly: { percent: 18, resetsAt: 3 },
    checkedAt: 1,
  }

  function withUsage() {
    const runs: boolean[] = []
    const usage = {
      run: (on: boolean) => runs.push(on),
      usageOf: (id: string) => (id === WORK_ID ? checked : null),
    }
    const withPoller = new ClaudeAccounts({
      store,
      root,
      defaultHome: () => home,
      defaultLogin: async () => defaultLogin,
      profileLogin: async () => null,
      loginState: async (dir) => (dir.endsWith(OUT_ID) ? 'signed-out' : 'signed-in'),
      writeLogin: async () => true,
      signIn: null,
      usage,
      syncProfile: async () => {},
      agentRunning: () => false,
      paneOf: (id) => id,
      openLoginTab: async () => null,
      onChange: (state) => published.push(state),
    })
    return { withPoller, runs }
  }

  it('is unavailable without a poller, as on macOS, and cannot be turned on', async () => {
    expect(await accounts.setCheckUsage(true)).toBe(false)
    expect(await accounts.state()).toMatchObject({ checkUsage: false, usageAvailable: false })
  })

  it('starts the poller at boot only when the human left the check on', async () => {
    const { withPoller, runs } = withUsage()
    await withPoller.boot()
    expect(runs).toEqual([false])
    store.setCheckUsage(true)
    await withPoller.boot()
    expect(runs).toEqual([false, true])
  })

  it('turns the check on, publishes it and shows each account’s last answer', async () => {
    store.add({ id: WORK_ID, email: 'work@example.com', addedAt: 1 })
    const { withPoller, runs } = withUsage()
    expect(await withPoller.setCheckUsage(true)).toBe(true)
    expect(runs).toEqual([true])
    const state = published.at(-1)
    expect(state).toMatchObject({ checkUsage: true, usageAvailable: true })
    expect(state?.accounts.map((a) => a.usage)).toEqual([null, checked])
  })

  it('checks the default and every signed-in account, never a signed-out one', async () => {
    store.add({ id: WORK_ID, email: 'work@example.com', addedAt: 1 })
    store.add({ id: OUT_ID, email: 'out@example.com', addedAt: 1 })
    const { withPoller } = withUsage()
    expect(await withPoller.usageTargets()).toEqual([
      { id: 'default', dir: home },
      { id: WORK_ID, dir: join(root, WORK_ID) },
    ])
  })

  it('never checks an account that is turned off, and shows no usage for it', async () => {
    store.add({ id: WORK_ID, email: 'work@example.com', addedAt: 1 })
    const { withPoller } = withUsage()
    expect(await withPoller.setEnabled(WORK_ID, false)).toBe('done')
    expect(await withPoller.usageTargets()).toEqual([{ id: 'default', dir: home }])
    const work = (await withPoller.state()).accounts[1]
    expect(work).toMatchObject({ enabled: false, usage: null })
  })
})

describe('turning an account off', () => {
  const WORK_ID = 'a'.repeat(16)

  beforeEach(() => {
    store.add({ id: WORK_ID, email: 'work@example.com', addedAt: 1 })
  })

  it('keeps the account listed and signed in, and publishes it off', async () => {
    expect(await accounts.setEnabled(WORK_ID, false)).toBe('done')
    expect(published.at(-1)?.accounts.map((a) => [a.email, a.enabled, a.signedOut])).toEqual([
      ['me@example.com', true, false],
      ['work@example.com', false, false],
    ])
    expect(await accounts.use(WORK_ID)).toBe(false)
    expect(await accounts.setEnabled(WORK_ID, true)).toBe('done')
    expect(await accounts.use(WORK_ID)).toBe(true)
  })

  it('refuses the default account, the current one and an unknown id', async () => {
    expect(await accounts.setEnabled('default', false)).toBe('default')
    await accounts.use(WORK_ID)
    expect(await accounts.setEnabled(WORK_ID, false)).toBe('current')
    expect(await accounts.setEnabled('c'.repeat(16), false)).toBe('unknown')
  })
})

describe('adding an account', () => {
  it('opens a terminal on a new profile and lists the account once the login is seen', async () => {
    expect(await accounts.add(TARGET)).toBe('opened')
    const dir = dirOf()
    expect(existsSync(dir)).toBe(true)
    expect((await accounts.state()).adding).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(store.accounts()).toEqual([])
    signIn(dir, 'work@example.com')
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.accounts().map((a) => a.email)).toEqual(['work@example.com'])
    await vi.waitFor(() => expect(published.at(-1)?.adding).toBe(false))
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(join(dir, '.ostia-pending'))).toBe(false)
  })

  it('does not open a second login while one is waiting', async () => {
    await accounts.add(TARGET)
    expect(await accounts.add(TARGET)).toBe('busy')
    expect(opened).toHaveLength(1)
  })

  it('removes the folder again when no tab opened', async () => {
    openResult = null
    expect(await accounts.add(TARGET)).toBe('not-opened')
    expect(existsSync(dirOf())).toBe(false)
    expect((await accounts.state()).adding).toBe(false)
  })

  it('removes the folder when the tab closes before the login', async () => {
    await accounts.add(TARGET)
    await accounts.paneClosed('pane-ext-1')
    expect(existsSync(dirOf())).toBe(false)
    expect((await accounts.state()).adding).toBe(false)
    expect(store.accounts()).toEqual([])
  })

  it('hands the tab the window and workspace the human clicked in', async () => {
    const open = vi.fn(async () => 'pane-ext-1')
    const again = new ClaudeAccounts({
      store,
      root,
      defaultHome: () => home,
      defaultLogin: async () => null,
      profileLogin: async () => null,
      loginState: async () => 'signed-in',
      writeLogin: async () => true,
      signIn: null,
      usage: null,
      syncProfile: async () => {},
      agentRunning: () => false,
      paneOf: (id) => id,
      openLoginTab: open,
      onChange: () => {},
    })
    await again.add(TARGET)
    expect(open).toHaveBeenCalledWith(expect.stringContaining(root), TARGET)
    await again.paneClosed('pane-ext-1')
  })

  it('keeps the account when the tab closes right after the login', async () => {
    await accounts.add(TARGET)
    signIn(dirOf(), 'work@example.com')
    await accounts.paneClosed('pane-ext-1')
    expect(store.accounts().map((a) => a.email)).toEqual(['work@example.com'])
  })

  it('ignores the closing of another tab', async () => {
    await accounts.add(TARGET)
    await accounts.paneClosed('pane-other')
    expect((await accounts.state()).adding).toBe(true)
  })

  it('gives up after the timeout and removes the folder', async () => {
    await accounts.add(TARGET)
    await vi.advanceTimersByTimeAsync(62_000)
    await vi.waitFor(() => expect(existsSync(dirOf())).toBe(false))
    expect((await accounts.state()).adding).toBe(false)
  })

  it.each([
    ['the default account', 'ME@example.com', 'default'],
    ['an account already added', 'work@example.com', 'a'.repeat(16)],
  ])('refuses %s signed in again, removes the folder and says which', async (_name, email, of) => {
    store.add({ id: 'a'.repeat(16), email: 'work@example.com', addedAt: 1 })
    await accounts.add(TARGET)
    signIn(dirOf(), email)
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.accounts()).toHaveLength(1)
    await vi.waitFor(() => expect(published.at(-1)?.duplicate).toBe(of))
    expect(existsSync(dirOf())).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(published.at(-1)?.duplicate).toBeNull()
  })
})

describe('the same login under another address', () => {
  const WORK_ID = 'a'.repeat(16)

  it('refuses a new profile whose login id is the default account’s', async () => {
    defaultLogin = { uuid: 'same-id', email: 'me@example.com' }
    await accounts.add(TARGET)
    signIn(dirOf(), 'renamed@example.com', 'same-id')
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.accounts()).toHaveLength(0)
    await vi.waitFor(() => expect(published.at(-1)?.duplicate).toBe('default'))
    expect(existsSync(dirOf())).toBe(false)
  })

  it('flags a listed account that shares the default account’s login and removes nothing', async () => {
    defaultLogin = { uuid: 'same-id', email: 'me@example.com' }
    store.add({ id: WORK_ID, email: 'renamed@example.com', addedAt: 1 })
    uuids.set(join(root, WORK_ID), 'same-id')
    emails.set(join(root, WORK_ID), 'renamed@example.com')
    const state = await accounts.state()
    expect(state.accounts.map((a) => a.sameAs)).toEqual([null, 'default'])
    expect(store.accounts()).toHaveLength(1)
  })

  it('flags the later of two listed accounts with one login', async () => {
    const other = 'b'.repeat(16)
    store.add({ id: WORK_ID, email: 'work@example.com', addedAt: 1 })
    store.add({ id: other, email: 'Work@example.com', addedAt: 2 })
    const state = await accounts.state()
    expect(state.accounts.map((a) => a.sameAs)).toEqual([null, null, WORK_ID])
  })

  it('flags nothing for different logins', async () => {
    store.add({ id: WORK_ID, email: 'work@example.com', addedAt: 1 })
    expect((await accounts.state()).accounts.map((a) => a.sameAs)).toEqual([null, null])
  })
})

describe('removing and choosing an account', () => {
  async function addWork(): Promise<string> {
    await accounts.add(TARGET)
    const dir = dirOf(opened.length - 1)
    signIn(dir, `work${opened.length}@example.com`)
    await vi.advanceTimersByTimeAsync(1000)
    return store.accounts().at(-1)?.id ?? ''
  }

  it('removes the profile folder and the account, and publishes', async () => {
    const id = await addWork()
    expect(await accounts.remove(id)).toBe('removed')
    expect(existsSync(join(root, id))).toBe(false)
    expect(store.accounts()).toEqual([])
    expect(published.at(-1)?.accounts).toHaveLength(1)
  })

  it('removes nothing for an id it does not hold', async () => {
    const id = await addWork()
    expect(await accounts.remove('f'.repeat(16))).toBe('unknown')
    expect(await accounts.remove('../escape')).toBe('unknown')
    expect(existsSync(join(root, id))).toBe(true)
  })

  it('refuses while a pane runs Claude on the account, and removes it once that ends', async () => {
    const id = await addWork()
    store.use(id)
    await accounts.startDirectory('pane-1')
    running.add('pane-1')
    expect(await accounts.remove(id)).toBe('running')
    expect(existsSync(join(root, id))).toBe(true)
    expect(store.has(id)).toBe(true)
    running.delete('pane-1')
    expect(await accounts.remove(id)).toBe('removed')
  })

  it('ignores a running pane that is on another account', async () => {
    const id = await addWork()
    await accounts.startDirectory('pane-1')
    running.add('pane-1')
    expect(await accounts.remove(id)).toBe('removed')
  })

  it('switches the account new sessions use', async () => {
    const id = await addWork()
    expect(await accounts.use(id)).toBe(true)
    expect(published.at(-1)?.current).toBe(id)
    expect(await accounts.use('f'.repeat(16))).toBe(false)
  })
})

describe('boot', () => {
  const OLD = 'c'.repeat(16)
  const KEPT = 'd'.repeat(16)

  function service(file: string, now = Date.now()): ClaudeAccounts {
    return new ClaudeAccounts({
      store: new ClaudeAccountsStore(file),
      root,
      defaultHome: () => home,
      defaultLogin: async () => ({ uuid: null, email: 'me@example.com' }),
      profileLogin: async (dir) =>
        emails.has(dir) ? { uuid: uuids.get(dir) ?? null, email: emails.get(dir) as string } : null,
      loginState: async () => 'signed-in',
      writeLogin: async () => true,
      signIn: null,
      usage: null,
      syncProfile: async () => {},
      agentRunning: () => false,
      paneOf: (id) => id,
      openLoginTab: async () => 'pane',
      onChange: (state) => published.push(state),
      now: () => now,
    })
  }

  function folder(id: string, email: string, pending: boolean): string {
    const dir = createProfile(root, id, home)
    signIn(dir, email)
    if (!pending) rmSync(join(dir, '.ostia-pending'))
    return dir
  }

  it('removes a pending folder past the wait only when it holds no login', async () => {
    mkdirSync(join(root, OLD), { recursive: true })
    createProfile(root, 'f'.repeat(16), home)
    folder(KEPT, 'kept@example.com', false)
    const later = Date.now() + 61 * 60 * 1000
    await service(join(base, 'fresh.json'), later).boot()
    expect(existsSync(join(root, 'f'.repeat(16)))).toBe(false)
    expect(existsSync(join(root, KEPT))).toBe(true)
  })

  it('keeps a pending folder that holds a finished sign-in and offers it back', async () => {
    const dir = folder(OLD, 'old@example.com', true)
    const again = service(join(base, 'fresh.json'), Date.now() + 61 * 60 * 1000)
    await again.boot()
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(join(dir, '.ostia-pending'))).toBe(false)
    expect(await again.state()).toMatchObject({ recoverable: 1 })
    expect(await again.recover()).toBe(1)
  })

  it('keeps a listed account whose marker was never removed, and drops the marker', async () => {
    const file = join(base, 'listed.json')
    const dir = folder(OLD, 'old@example.com', true)
    const seeded = new ClaudeAccountsStore(file)
    seeded.add({ id: OLD, email: 'old@example.com', addedAt: 1 })
    await service(file, Date.now() + 61 * 60 * 1000).boot()
    expect(existsSync(dir)).toBe(true)
    expect(existsSync(join(dir, '.ostia-pending'))).toBe(false)
    expect(new ClaudeAccountsStore(file).accounts()).toHaveLength(1)
  })

  it('keeps a login folder that is still inside the wait', async () => {
    folder(OLD, 'old@example.com', true)
    await service(join(base, 'fresh.json')).boot()
    expect(existsSync(join(root, OLD))).toBe(true)
  })

  it('keeps every profile across two boots when the store is damaged, then again when it is gone', async () => {
    const file = join(base, 'accounts-file.json')
    folder(KEPT, 'kept@example.com', false)
    writeFileSync(file, '{')
    const later = Date.now() + 24 * 60 * 60 * 1000
    await service(file, later).boot()
    expect(existsSync(join(root, KEPT))).toBe(true)
    await service(file, later).boot()
    expect(existsSync(join(root, KEPT))).toBe(true)
    await service(join(base, 'never-written.json'), later).boot()
    expect(existsSync(join(root, KEPT))).toBe(true)
  })

  it('keeps every profile when the store is missing, and offers to bring the sign-ins back', async () => {
    folder(KEPT, 'kept@example.com', false)
    const again = service(join(base, 'missing.json'))
    await again.boot()
    expect(existsSync(join(root, KEPT))).toBe(true)
    expect(await again.state()).toMatchObject({ recoverable: 1, damaged: false })
  })

  it('brings back the signed-in folders when the human starts fresh from a damaged store', async () => {
    const file = join(base, 'accounts-file.json')
    folder(KEPT, 'kept@example.com', false)
    folder(OLD, 'me@example.com', false)
    mkdirSync(join(root, 'e'.repeat(16)))
    writeFileSync(file, '{')
    const damaged = service(file)
    await damaged.boot()
    expect(await damaged.recover()).toBe(1)
    expect(published.at(-1)).toMatchObject({ damaged: false, recoverable: 0 })
    const listed = await new ClaudeAccountsStore(file).accounts()
    expect(listed.map((a) => a.email)).toEqual(['kept@example.com'])
    expect(existsSync(join(root, OLD))).toBe(true)
    await service(file, Date.now() + 24 * 60 * 60 * 1000).boot()
    expect(existsSync(join(root, KEPT))).toBe(true)
  })

  it('has nothing to bring back from a healthy list', async () => {
    const healthy = service(join(base, 'fresh.json'))
    await healthy.boot()
    expect(await healthy.recover()).toBeNull()
  })

  it('refuses to add, remove or choose while the list is damaged', async () => {
    const file = join(base, 'damaged.json')
    writeFileSync(file, '{')
    const guarded = service(file)
    expect((await guarded.state()).damaged).toBe(true)
    expect(await guarded.add(TARGET)).toBe('damaged')
    expect(await guarded.remove(KEPT)).toBe('damaged')
  })
})

describe('a Claude running in the login tab', () => {
  it('blocks Remove of the account it just signed in', async () => {
    await accounts.add(TARGET)
    signIn(dirOf(), 'work@example.com')
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(store.accounts()).toHaveLength(1))
    const id = store.accounts()[0].id
    await vi.waitFor(() => expect(store.accountOfPane('pane-ext-1')).toBe(id))
    running.add('pane-ext-1')
    expect(await accounts.remove(id)).toBe('running')
    expect(existsSync(join(root, id))).toBe(true)
  })
})

describe('a Claude still running after Ostia restarted', () => {
  it('still blocks Remove, because the pane’s account is stored with the list', async () => {
    await accounts.add(TARGET)
    signIn(dirOf(), 'work@example.com')
    await vi.advanceTimersByTimeAsync(1000)
    const id = store.accounts()[0].id
    store.use(id)
    await accounts.startDirectory('pane-kept')
    const restarted = new ClaudeAccounts({
      store: new ClaudeAccountsStore(join(base, 'claude-accounts.json')),
      root,
      defaultHome: () => home,
      defaultLogin: async () => null,
      profileLogin: async () => null,
      loginState: async () => 'signed-in',
      writeLogin: async () => true,
      signIn: null,
      usage: null,
      syncProfile: async () => {},
      agentRunning: (paneId) => paneId === 'pane-kept',
      paneOf: (id) => id,
      openLoginTab: async () => 'pane',
      onChange: () => {},
    })
    expect(await restarted.remove(id)).toBe('running')
    expect(existsSync(join(root, id))).toBe(true)
  })
})

describe('which profile a Claude starts on', () => {
  const WORK = 'a'.repeat(16)

  beforeEach(() => {
    store.add({ id: WORK, email: 'work@example.com', addedAt: 1 })
  })

  it('answers no folder while the default account is current, and syncs nothing', async () => {
    expect(await accounts.startDirectory('pane-1')).toBe('')
    expect(accounts.configDir()).toBeUndefined()
    expect(synced).toEqual([])
  })

  it('answers the current account’s folder, after copying the default’s settings into it', async () => {
    store.use(WORK)
    expect(await accounts.startDirectory('pane-1')).toBe(join(root, WORK))
    expect(synced).toEqual([join(root, WORK)])
    expect(accounts.configDir()).toBe(join(root, WORK))
  })

  it('CLA-M5 starts a resumed or woken session on the current account, whatever it ran on before', async () => {
    store.use(WORK)
    expect(await accounts.startDirectory('pane-1')).toBe(join(root, WORK))
    store.use('default')
    expect(await accounts.startDirectory('pane-1')).toBe('')
    expect(store.accountOfPane('pane-1')).toBe('default')
  })

  it('remembers the account each pane started on', async () => {
    store.use(WORK)
    await accounts.startDirectory('pane-1')
    store.use('default')
    expect(store.accountOfPane('pane-1')).toBe(WORK)
  })
})
