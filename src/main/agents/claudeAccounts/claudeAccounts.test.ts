import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAccountsState } from '../../../shared/claudeAccounts/claudeAccounts'
import { createProfile } from './accountProfiles'
import { ClaudeAccountsStore } from './accountsStore'
import { ClaudeAccounts } from './claudeAccounts'

let base: string
let root: string
let home: string
let store: ClaudeAccountsStore
let emails: Map<string, string>
let defaultEmail: string | null
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

function signIn(dir: string, email: string): void {
  writeFileSync(join(dir, '.credentials.json'), 'x')
  emails.set(dir, email)
}

beforeEach(() => {
  vi.useFakeTimers()
  base = mkdtempSync(join(tmpdir(), 'ostia-accounts-'))
  root = join(base, 'claude-accounts')
  home = join(base, 'dot-claude')
  mkdirSync(home)
  store = new ClaudeAccountsStore(join(base, 'claude-accounts.json'))
  emails = new Map()
  defaultEmail = 'me@example.com'
  opened = []
  openResult = 'pane-ext-1'
  published = []
  synced = []
  running = new Set()
  accounts = new ClaudeAccounts({
    store,
    root,
    defaultHome: () => home,
    defaultEmail: async () => defaultEmail,
    profileEmail: async (dir) => emails.get(dir) ?? null,
    syncProfile: async (dir) => {
      synced.push(dir)
    },
    agentRunning: (paneId) => running.has(paneId),
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
      defaultEmail: async () => null,
      profileEmail: async () => null,
      syncProfile: async () => {},
      agentRunning: () => false,
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
    ['the default account', 'ME@example.com'],
    ['an account already added', 'work@example.com'],
  ])('refuses %s signed in again, removes the folder and says which', async (_name, email) => {
    store.add({ id: 'a'.repeat(16), email: 'work@example.com', addedAt: 1 })
    await accounts.add(TARGET)
    signIn(dirOf(), email)
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.accounts()).toHaveLength(1)
    await vi.waitFor(() => expect(published.at(-1)?.duplicate).toBe(email))
    expect(existsSync(dirOf())).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(published.at(-1)?.duplicate).toBeNull()
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
    await accounts.startDirectory([], 'pane-1')
    running.add('pane-1')
    expect(await accounts.remove(id)).toBe('running')
    expect(existsSync(join(root, id))).toBe(true)
    expect(store.has(id)).toBe(true)
    running.delete('pane-1')
    expect(await accounts.remove(id)).toBe('removed')
  })

  it('ignores a running pane that is on another account', async () => {
    const id = await addWork()
    await accounts.startDirectory([], 'pane-1')
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
      defaultEmail: async () => 'me@example.com',
      profileEmail: async (dir) => emails.get(dir) ?? null,
      syncProfile: async () => {},
      agentRunning: () => false,
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

  it('removes only a login folder that stayed pending past the wait', async () => {
    folder(OLD, 'old@example.com', true)
    folder(KEPT, 'kept@example.com', false)
    await service(join(base, 'fresh.json'), Date.now() + 61 * 60 * 1000).boot()
    expect(existsSync(join(root, OLD))).toBe(false)
    expect(existsSync(join(root, KEPT))).toBe(true)
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

describe('a Claude still running after Ostia restarted', () => {
  it('still blocks Remove, because the pane’s account is stored with the list', async () => {
    await accounts.add(TARGET)
    signIn(dirOf(), 'work@example.com')
    await vi.advanceTimersByTimeAsync(1000)
    const id = store.accounts()[0].id
    store.use(id)
    await accounts.startDirectory([], 'pane-kept')
    const restarted = new ClaudeAccounts({
      store: new ClaudeAccountsStore(join(base, 'claude-accounts.json')),
      root,
      defaultHome: () => home,
      defaultEmail: async () => null,
      profileEmail: async () => null,
      syncProfile: async () => {},
      agentRunning: (paneId) => paneId === 'pane-kept',
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
    expect(await accounts.startDirectory([], 'pane-1')).toBe('')
    expect(accounts.configDirFor(null)).toBeUndefined()
    expect(synced).toEqual([])
  })

  it('answers the current account’s folder for a new session, after copying the default’s settings into it', async () => {
    store.use(WORK)
    expect(await accounts.startDirectory(['--model', 'opus'], 'pane-1')).toBe(join(root, WORK))
    expect(synced).toEqual([join(root, WORK)])
    expect(accounts.configDirFor(null)).toBe(join(root, WORK))
  })

  it('starts a resumed or forked session on the account it ran on, whatever is current now', async () => {
    store.rememberSession('old-session', WORK)
    store.rememberSession('default-session', 'default')
    store.use(WORK)
    expect(await accounts.startDirectory(['--resume', 'default-session'], 'pane-1')).toBe('')
    store.use('default')
    expect(
      await accounts.startDirectory(['--resume', 'old-session', '--fork-session'], 'pane-1'),
    ).toBe(join(root, WORK))
    expect(accounts.configDirFor('old-session')).toBe(join(root, WORK))
  })

  it('falls back to the current account when the remembered one was removed', async () => {
    store.rememberSession('old-session', WORK)
    await accounts.remove(WORK)
    expect(await accounts.startDirectory(['--resume', 'old-session'], 'pane-1')).toBe('')
  })

  it('remembers the account a pane started on with the session id it then reports', async () => {
    store.use(WORK)
    await accounts.startDirectory([], 'pane-1')
    store.use('default')
    accounts.sessionStarted('pane-1', 'fresh-session')
    expect(store.accountOfSession('fresh-session')).toBe(WORK)
  })

  it('remembers nothing for a pane Ostia never chose an account for', () => {
    accounts.sessionStarted('pane-unknown', 'typed-by-hand')
    expect(store.accountOfSession('typed-by-hand')).toBeUndefined()
  })
})
