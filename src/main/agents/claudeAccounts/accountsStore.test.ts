import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

  it('keeps accounts and the current one across a restart, in a 0600 file', () => {
    const store = new ClaudeAccountsStore(file)
    store.add(account(WORK, 'work@example.com'))
    store.use(WORK)
    const again = new ClaudeAccountsStore(file)
    expect(again.accounts()).toEqual([account(WORK, 'work@example.com')])
    expect(again.current()).toBe(WORK)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('keeps the usage check off until it is turned on, across a restart', () => {
    const store = new ClaudeAccountsStore(file)
    expect(store.checkUsage()).toBe(false)
    expect(store.setCheckUsage(true)).toBe(true)
    expect(new ClaudeAccountsStore(file).checkUsage()).toBe(true)
  })

  it('turns an account off across a restart, never the current one, and forgets it with the account', () => {
    const store = new ClaudeAccountsStore(file)
    store.add(account(WORK, 'work@example.com'))
    expect(store.setEnabled(WORK, false)).toBe(true)
    expect(new ClaudeAccountsStore(file).isEnabled(WORK)).toBe(false)
    expect(store.use(WORK)).toBe(false)
    expect(store.setEnabled(WORK, true)).toBe(true)
    expect(store.use(WORK)).toBe(true)
    expect(store.setEnabled(WORK, false)).toBe(false)
    store.use('default')
    store.setEnabled(WORK, false)
    store.remove(WORK)
    store.add(account(WORK, 'work@example.com'))
    expect(store.isEnabled(WORK)).toBe(true)
  })

  it('refuses to use or remember an account it does not know', () => {
    const store = new ClaudeAccountsStore(file)
    expect(store.use(WORK)).toBe(false)
    store.rememberPane('p1', WORK)
    expect(store.accountOfPane('p1')).toBeUndefined()
    expect(store.use('default')).toBe(true)
  })

  it('forgets an account with its panes and falls back to the default when it was current', () => {
    const store = new ClaudeAccountsStore(file)
    store.add(account(WORK, 'work@example.com'))
    store.add(account(SPARE, 'spare@example.com'))
    store.use(WORK)
    store.rememberPane('on-work', WORK)
    store.rememberPane('on-spare', SPARE)
    expect(store.remove(WORK)).toBe(true)
    expect(store.current()).toBe('default')
    expect(store.accountOfPane('on-work')).toBeUndefined()
    expect(store.accountOfPane('on-spare')).toBe(SPARE)
    expect(store.remove(WORK)).toBe(false)
  })

  it.each([
    ['not JSON', '{'],
    ['a newer format', JSON.stringify({ v: 2, accounts: [] })],
    ['accounts that are not a list', JSON.stringify({ v: 1, accounts: {} })],
    [
      'an account that does not parse',
      JSON.stringify({ v: 1, accounts: [{ id: '../x', email: 'x@example.com' }] }),
    ],
  ])(
    'sets %s aside, reads as damaged and refuses every write until the human starts fresh',
    (_name, text) => {
      writeFileSync(file, text)
      const store = new ClaudeAccountsStore(file, () => 42)
      expect(store.isDamaged).toBe(true)
      expect(existsSync(file)).toBe(false)
      expect(readFileSync(`${file}.corrupt-42`, 'utf8')).toBe(text)
      expect(statSync(`${file}.corrupt-42`).mode & 0o777).toBe(0o600)
      expect(store.add(account(WORK, 'work@example.com'))).toBe(false)
      expect(store.use('default')).toBe(false)
      store.rememberPane('p', 'default')
      expect(store.accountOfPane('p')).toBeUndefined()
      expect(existsSync(file)).toBe(false)
      expect(store.startFresh()).toBe(true)
      expect(store.isDamaged).toBe(false)
      expect(store.add(account(WORK, 'work@example.com'))).toBe(true)
      expect(new ClaudeAccountsStore(file).accounts()).toHaveLength(1)
    },
  )

  it('remembers which pane started on which account, across a restart, and forgets them with the account', () => {
    const store = new ClaudeAccountsStore(file)
    store.add(account(WORK, 'work@example.com'))
    store.rememberPane('p1', WORK)
    store.rememberPane('p2', 'default')
    const again = new ClaudeAccountsStore(file)
    expect(again.accountOfPane('p1')).toBe(WORK)
    expect(again.panesOn(WORK)).toEqual(['p1'])
    again.remove(WORK)
    expect(again.accountOfPane('p1')).toBeUndefined()
    expect(again.accountOfPane('p2')).toBe('default')
  })

  it('has nothing to start fresh from a healthy file', () => {
    expect(new ClaudeAccountsStore(file).startFresh()).toBe(false)
  })

  it('drops a pane or the current account that points at an unknown account', () => {
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        accounts: [account(WORK, 'work@example.com')],
        current: SPARE,
        panes: { good: WORK, bad: SPARE, worse: 3 },
      }),
    )
    const store = new ClaudeAccountsStore(file)
    expect(store.isDamaged).toBe(false)
    expect(store.current()).toBe('default')
    expect(store.accountOfPane('good')).toBe(WORK)
    expect(store.accountOfPane('bad')).toBeUndefined()
  })

  it('keeps no account per session: an older file loses that list at the next write', () => {
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        accounts: [account(WORK, 'work@example.com')],
        sessions: { s: WORK },
      }),
    )
    new ClaudeAccountsStore(file).use(WORK)
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('sessions')
  })

  it('writes the file as JSON', () => {
    new ClaudeAccountsStore(file).add(account(WORK, 'work@example.com'))
    expect(JSON.parse(readFileSync(file, 'utf8')).accounts).toHaveLength(1)
  })
})
