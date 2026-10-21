import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeAccountsStore } from './accountsStore'

const WORK = 'a'.repeat(16)
const SPARE = 'b'.repeat(16)

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ostia-accounts-store-'))
  file = join(dir, 'claude-accounts.json')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const account = (id: string, email: string) => ({ id, email, addedAt: 1 })

describe('ClaudeAccountsStore', () => {
  it('starts with no accounts on the default one', () => {
    const store = new ClaudeAccountsStore(file)
    expect(store.accounts()).toEqual([])
    expect(store.current()).toBe('default')
  })

  it('keeps accounts, the current one and remembered sessions across a restart, in a 0600 file', () => {
    const store = new ClaudeAccountsStore(file)
    store.add(account(WORK, 'work@example.com'))
    store.use(WORK)
    store.rememberSession('session-1', WORK)
    store.rememberSession('session-2', 'default')
    const again = new ClaudeAccountsStore(file)
    expect(again.accounts()).toEqual([account(WORK, 'work@example.com')])
    expect(again.current()).toBe(WORK)
    expect(again.accountOfSession('session-1')).toBe(WORK)
    expect(again.accountOfSession('session-2')).toBe('default')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('refuses to use or remember an account it does not know', () => {
    const store = new ClaudeAccountsStore(file)
    expect(store.use(WORK)).toBe(false)
    store.rememberSession('session-1', WORK)
    expect(store.accountOfSession('session-1')).toBeUndefined()
    expect(store.use('default')).toBe(true)
  })

  it('forgets an account with its sessions and falls back to the default when it was current', () => {
    const store = new ClaudeAccountsStore(file)
    store.add(account(WORK, 'work@example.com'))
    store.add(account(SPARE, 'spare@example.com'))
    store.use(WORK)
    store.rememberSession('on-work', WORK)
    store.rememberSession('on-spare', SPARE)
    expect(store.remove(WORK)).toBe(true)
    expect(store.current()).toBe('default')
    expect(store.accountOfSession('on-work')).toBeUndefined()
    expect(store.accountOfSession('on-spare')).toBe(SPARE)
    expect(store.remove(WORK)).toBe(false)
  })

  it('keeps only the newest 500 sessions', () => {
    const store = new ClaudeAccountsStore(file)
    for (let i = 0; i < 502; i++) store.rememberSession(`s${i}`, 'default')
    expect(store.accountOfSession('s0')).toBeUndefined()
    expect(store.accountOfSession('s1')).toBeUndefined()
    expect(store.accountOfSession('s2')).toBe('default')
    expect(store.accountOfSession('s501')).toBe('default')
  })

  it('drops malformed entries and unknown ids from a damaged file', () => {
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        accounts: [account(WORK, 'work@example.com'), { id: '../x', email: 'x@example.com' }, 7],
        current: SPARE,
        sessions: { good: WORK, bad: SPARE, worse: 3 },
      }),
    )
    const store = new ClaudeAccountsStore(file)
    expect(store.accounts().map((a) => a.id)).toEqual([WORK])
    expect(store.current()).toBe('default')
    expect(store.accountOfSession('good')).toBe(WORK)
    expect(store.accountOfSession('bad')).toBeUndefined()
  })

  it('writes the file as JSON', () => {
    new ClaudeAccountsStore(file).add(account(WORK, 'work@example.com'))
    expect(JSON.parse(readFileSync(file, 'utf8')).accounts).toHaveLength(1)
  })
})
