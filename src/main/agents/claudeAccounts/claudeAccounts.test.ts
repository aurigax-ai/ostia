import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAccountsState } from '../../../shared/claudeAccounts/claudeAccounts'
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
  accounts = new ClaudeAccounts({
    store,
    root,
    defaultHome: () => home,
    defaultEmail: async () => defaultEmail,
    profileEmail: async (dir) => emails.get(dir) ?? null,
    openLoginTab: async (dir) => {
      opened.push(`CLAUDE_CONFIG_DIR=${dir}`)
      return openResult
    },
    onChange: (state) => published.push(state),
    pollMs: 1000,
    timeoutMs: 60_000,
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
    expect(await accounts.add()).toBe('opened')
    const dir = dirOf()
    expect(existsSync(dir)).toBe(true)
    expect((await accounts.state()).adding).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(store.accounts()).toEqual([])
    signIn(dir, 'work@example.com')
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.accounts().map((a) => a.email)).toEqual(['work@example.com'])
    expect(published.at(-1)?.adding).toBe(false)
    expect(existsSync(dir)).toBe(true)
  })

  it('does not open a second login while one is waiting', async () => {
    await accounts.add()
    expect(await accounts.add()).toBe('busy')
    expect(opened).toHaveLength(1)
  })

  it('removes the folder again when no tab opened', async () => {
    openResult = null
    expect(await accounts.add()).toBe('not-opened')
    expect(existsSync(dirOf())).toBe(false)
    expect((await accounts.state()).adding).toBe(false)
  })

  it('removes the folder when the tab closes before the login', async () => {
    await accounts.add()
    await accounts.paneClosed('pane-ext-1')
    expect(existsSync(dirOf())).toBe(false)
    expect((await accounts.state()).adding).toBe(false)
    expect(store.accounts()).toEqual([])
  })

  it('keeps the account when the tab closes right after the login', async () => {
    await accounts.add()
    signIn(dirOf(), 'work@example.com')
    await accounts.paneClosed('pane-ext-1')
    expect(store.accounts().map((a) => a.email)).toEqual(['work@example.com'])
  })

  it('ignores the closing of another tab', async () => {
    await accounts.add()
    await accounts.paneClosed('pane-other')
    expect((await accounts.state()).adding).toBe(true)
  })

  it('gives up after the timeout and removes the folder', async () => {
    await accounts.add()
    await vi.advanceTimersByTimeAsync(62_000)
    expect(existsSync(dirOf())).toBe(false)
    expect((await accounts.state()).adding).toBe(false)
  })

  it.each([
    ['the default account', 'ME@example.com'],
    ['an account already added', 'work@example.com'],
  ])('refuses %s signed in again, removes the folder and says which', async (_name, email) => {
    store.add({ id: 'a'.repeat(16), email: 'work@example.com', addedAt: 1 })
    await accounts.add()
    signIn(dirOf(), email)
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.accounts()).toHaveLength(1)
    expect(existsSync(dirOf())).toBe(false)
    expect(published.at(-1)?.duplicate).toBe(email)
    await accounts.add()
    expect(published.at(-1)?.duplicate).toBeNull()
  })
})

describe('removing and choosing an account', () => {
  async function addWork(): Promise<string> {
    await accounts.add()
    const dir = dirOf(opened.length - 1)
    signIn(dir, `work${opened.length}@example.com`)
    await vi.advanceTimersByTimeAsync(1000)
    return store.accounts().at(-1)?.id ?? ''
  }

  it('removes the profile folder and the account, and publishes', async () => {
    const id = await addWork()
    expect(await accounts.remove(id)).toBe(true)
    expect(existsSync(join(root, id))).toBe(false)
    expect(store.accounts()).toEqual([])
    expect(published.at(-1)?.accounts).toHaveLength(1)
  })

  it('removes nothing for an id it does not hold', async () => {
    const id = await addWork()
    expect(await accounts.remove('f'.repeat(16))).toBe(false)
    expect(await accounts.remove('../escape')).toBe(false)
    expect(existsSync(join(root, id))).toBe(true)
  })

  it('switches the account new sessions use', async () => {
    const id = await addWork()
    expect(await accounts.use(id)).toBe(true)
    expect(published.at(-1)?.current).toBe(id)
    expect(await accounts.use('f'.repeat(16))).toBe(false)
  })
})

describe('sweeping profile folders', () => {
  it('removes folders no account owns', async () => {
    mkdirSync(join(root, 'c'.repeat(16)), { recursive: true })
    accounts.sweepOrphans()
    expect(existsSync(join(root, 'c'.repeat(16)))).toBe(false)
  })
})

describe('which profile a Claude starts on', () => {
  const WORK = 'a'.repeat(16)

  beforeEach(() => {
    store.add({ id: WORK, email: 'work@example.com', addedAt: 1 })
  })

  it('answers no folder while the default account is current', () => {
    expect(accounts.startDirectory([], 'pane-1')).toBe('')
    expect(accounts.configDirFor(null)).toBeUndefined()
  })

  it('answers the current account’s folder for a new session', () => {
    store.use(WORK)
    expect(accounts.startDirectory(['--model', 'opus'], 'pane-1')).toBe(join(root, WORK))
    expect(accounts.configDirFor(null)).toBe(join(root, WORK))
  })

  it('starts a resumed or forked session on the account it ran on, whatever is current now', () => {
    store.rememberSession('old-session', WORK)
    store.rememberSession('default-session', 'default')
    store.use(WORK)
    expect(accounts.startDirectory(['--resume', 'default-session'], 'pane-1')).toBe('')
    store.use('default')
    expect(accounts.startDirectory(['--resume', 'old-session', '--fork-session'], 'pane-1')).toBe(
      join(root, WORK),
    )
    expect(accounts.configDirFor('old-session')).toBe(join(root, WORK))
  })

  it('falls back to the current account when the remembered one was removed', async () => {
    store.rememberSession('old-session', WORK)
    await accounts.remove(WORK)
    expect(accounts.startDirectory(['--resume', 'old-session'], 'pane-1')).toBe('')
  })

  it('remembers the account a pane started on with the session id it then reports', () => {
    store.use(WORK)
    accounts.startDirectory([], 'pane-1')
    store.use('default')
    accounts.sessionStarted('pane-1', 'fresh-session')
    expect(store.accountOfSession('fresh-session')).toBe(WORK)
  })

  it('remembers nothing for a pane Ostia never chose an account for', () => {
    accounts.sessionStarted('pane-unknown', 'typed-by-hand')
    expect(store.accountOfSession('typed-by-hand')).toBeUndefined()
  })
})
