import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlMethodContext } from '../../control/controlServer'
import type { PaneIdentity } from '../../control/idRegistry'

type Handler = (params: unknown, ctx: ControlMethodContext) => unknown
const registered = new Map<string, { handler: Handler; cap?: string; callers?: string }>()
const ipc = new Map<string, (...args: unknown[]) => unknown>()
let base: string

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => ipc.set(channel, fn),
  },
}))
vi.mock('../../control/controlServer', () => ({
  registerControlMethod: (name: string, method: { handler: Handler }) =>
    registered.set(name, method),
}))
vi.mock('../../control/idRegistry', () => ({ resolveExternal: vi.fn() }))

import { resolveExternal } from '../../control/idRegistry'
import { ClaudeAccountsStore } from './accountsStore'
import { ClaudeAccounts } from './claudeAccounts'
import { registerClaudeAccountsWiring } from './claudeAccountsWiring'

const WORK = 'a'.repeat(16)
const window = { sender: { getType: () => 'window' } }
const guest = { sender: { getType: () => 'webview' } }

let resumeListener: ((pane: string, resume: unknown) => void) | undefined
let sandboxed: Set<string>
let store: ClaudeAccountsStore

const pane = (extra: Partial<PaneIdentity> = {}) =>
  ({ identity: { paneId: 'p1', workspaceId: 'w1', ...extra } }) as unknown as ControlMethodContext

beforeEach(() => {
  registered.clear()
  ipc.clear()
  sandboxed = new Set()
  base = mkdtempSync(join(tmpdir(), 'ostia-accounts-wiring-'))
  store = new ClaudeAccountsStore(join(base, 'accounts.json'))
  store.add({ id: WORK, email: 'work@example.com', addedAt: 1 })
  const claudeAccounts = new ClaudeAccounts({
    store,
    root: join(base, 'profiles'),
    defaultHome: () => join(base, 'home'),
    defaultEmail: async () => 'me@example.com',
    profileEmail: async () => null,
    openLoginTab: async () => null,
    onChange: () => {},
  })
  registerClaudeAccountsWiring({
    claudeAccounts,
    agentResumes: { subscribe: (fn: typeof resumeListener) => (resumeListener = fn) } as never,
    workspaceSandboxes: { isEnabled: (id: string) => sandboxed.has(id) },
  })
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

const call = (name: string, params: unknown, ctx = pane()) =>
  registered.get(name)?.handler(params, ctx)

describe('account.list and account.switch', () => {
  it('list the default account first and mark the current one', async () => {
    store.use(WORK)
    expect(await call('account.list', undefined)).toEqual({
      accounts: [
        { number: 1, email: 'me@example.com', current: false },
        { number: 2, email: 'work@example.com', current: true },
      ],
    })
  })

  it('switch by number or email, and answer unknown-account for anything else', async () => {
    expect(await call('account.switch', { target: '2' })).toEqual({
      ok: true,
      number: 2,
      email: 'work@example.com',
    })
    expect(store.current()).toBe(WORK)
    expect(await call('account.switch', { target: 'me@example.com' })).toMatchObject({ ok: true })
    expect(store.current()).toBe('default')
    expect(await call('account.switch', { target: 'nobody@example.com' })).toEqual({
      ok: false,
      error: 'unknown-account',
    })
    expect(await call('account.switch', {})).toEqual({ ok: false, error: 'invalid-params' })
  })

  it('need settings-write to switch, so an agent raises the approval card, and settings-read to list', () => {
    expect(registered.get('account.switch')?.cap).toBe('settings-write')
    expect(registered.get('account.list')?.cap).toBe('settings-read')
  })
})

describe('claudeAccount.start', () => {
  it('answers the current profile folder to a plain pane', () => {
    store.use(WORK)
    expect(call('claudeAccount.start', { args: [] })).toEqual({ dir: join(base, 'profiles', WORK) })
  })

  it('answers nothing to a sandboxed workspace and to the manager pane', () => {
    store.use(WORK)
    sandboxed.add('w1')
    expect(call('claudeAccount.start', { args: [] })).toEqual({ dir: '' })
    sandboxed.clear()
    expect(call('claudeAccount.start', { args: [] }, pane({ manager: true }))).toEqual({ dir: '' })
  })

  it('needs no capability, so a Claude start is never held by an approval', () => {
    expect(registered.get('claudeAccount.start')?.cap).toBeUndefined()
  })

  it('ignores arguments that are not strings', () => {
    expect(call('claudeAccount.start', { args: [1, null, '--resume', 'x'] })).toEqual({ dir: '' })
    expect(call('claudeAccount.start', { args: 'nope' })).toEqual({ dir: '' })
  })
})

describe('remembering the account of a session', () => {
  it('stores the account the pane started on when the agent reports its session', () => {
    store.use(WORK)
    call('claudeAccount.start', { args: [] })
    store.use('default')
    vi.mocked(resolveExternal).mockReturnValue({ kind: 'pane', paneId: 'p1' } as never)
    resumeListener?.('ext-p1', { agent: 'claude', id: 'session-1' })
    expect(store.accountOfSession('session-1')).toBe(WORK)
  })

  it('ignores another agent’s session and a pane it cannot resolve', () => {
    call('claudeAccount.start', { args: [] })
    vi.mocked(resolveExternal).mockReturnValue({ kind: 'pane', paneId: 'p1' } as never)
    resumeListener?.('ext-p1', { agent: 'codex', id: 'session-2' })
    vi.mocked(resolveExternal).mockReturnValue(undefined)
    resumeListener?.('ext-p1', { agent: 'claude', id: 'session-3' })
    expect(store.accountOfSession('session-2')).toBeUndefined()
    expect(store.accountOfSession('session-3')).toBeUndefined()
  })
})

describe('the window channels', () => {
  it('answer only a window, never a guest page', async () => {
    expect(await ipc.get('claude-accounts:state')?.(window)).toMatchObject({ current: 'default' })
    expect(await ipc.get('claude-accounts:state')?.(guest)).toMatchObject({
      accounts: [{ id: 'default' }],
    })
    expect(await ipc.get('claude-accounts:use')?.(guest, WORK)).toBe(false)
    expect(store.current()).toBe('default')
    expect(await ipc.get('claude-accounts:use')?.(window, WORK)).toBe(true)
    expect(await ipc.get('claude-accounts:remove')?.(guest, WORK)).toBe(false)
    expect(await ipc.get('claude-accounts:remove')?.(window, 7)).toBe(false)
    expect(await ipc.get('claude-accounts:remove')?.(window, WORK)).toBe(true)
    expect(await ipc.get('claude-accounts:add')?.(guest)).toBe('not-opened')
  })
})
