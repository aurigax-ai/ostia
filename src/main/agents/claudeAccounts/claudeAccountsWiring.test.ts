import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlMethodContext } from '../../control/controlServer'

type Handler = (params: unknown, ctx: ControlMethodContext) => unknown
const registered = new Map<string, { handler: Handler; cap?: string }>()
const ipc = new Map<string, (...args: unknown[]) => unknown>()
let base: string
let request = vi.fn()
let hasApprover = true

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
vi.mock('../../approvals/approvals', () => ({
  approvals: () => (hasApprover ? { request } : null),
}))
vi.mock('../../panes/paneList', () => ({
  listWorkspaces: async () => [
    { workspaceId: 'ws-1', kind: 'terminal' },
    { workspaceId: 'ws-browser', kind: 'browser' },
    { workspaceId: 'ws-sandbox', kind: 'terminal' },
    { workspaceId: 'ws-scratch', kind: 'terminal' },
    { workspaceId: 'ws-other', kind: 'terminal' },
  ],
}))

import { resolveExternal } from '../../control/idRegistry'
import { ClaudeAccountsStore } from './accountsStore'
import { ClaudeAccounts, type LoginTarget } from './claudeAccounts'
import { registerClaudeAccountsWiring } from './claudeAccountsWiring'

const WORK = 'a'.repeat(16)
const windowEvent = { sender: { getType: () => 'window', id: 1 } }
const guestEvent = { sender: { getType: () => 'webview', id: 1 } }

let resumeListener: ((pane: string, resume: unknown) => void) | undefined
let sandboxed: Set<string>
let scratch: Set<string>
let store: ClaudeAccountsStore
let opened: LoginTarget[]

const ctx = (extra: Record<string, unknown> = {}) =>
  ({
    identity: {
      kind: 'pane',
      paneId: 'p1',
      externalId: 'ext-p1',
      windowId: '1',
      workspaceId: 'w1',
      ...extra,
    },
  }) as unknown as ControlMethodContext

const call = (name: string, params: unknown, context = ctx()) =>
  registered.get(name)?.handler(params, context)

beforeEach(() => {
  registered.clear()
  ipc.clear()
  hasApprover = true
  request = vi.fn(async () => 'once')
  sandboxed = new Set(['ws-sandbox'])
  scratch = new Set(['ws-scratch'])
  opened = []
  base = mkdtempSync(join(tmpdir(), 'ostia-accounts-wiring-'))
  store = new ClaudeAccountsStore(join(base, 'accounts.json'))
  store.add({ id: WORK, email: 'work@example.com', addedAt: 1 })
  const claudeAccounts = new ClaudeAccounts({
    store,
    root: join(base, 'profiles'),
    defaultHome: () => join(base, 'home'),
    defaultEmail: async () => 'me@example.com',
    profileEmail: async () => null,
    syncProfile: async () => {},
    agentRunning: () => false,
    openLoginTab: async (_dir, target) => {
      opened.push(target)
      return 'login-pane'
    },
    onChange: () => {},
  })
  registerClaudeAccountsWiring({
    claudeAccounts,
    agentResumes: { subscribe: (fn: typeof resumeListener) => (resumeListener = fn) } as never,
    workspaceSandboxes: { isEnabled: (id: string) => sandboxed.has(id) },
    scratchFolders: { isScratch: (id: string) => scratch.has(id) },
    workspaceWindowId: (id: string) => (id === 'ws-other' ? '2' : '1'),
    execCommand: vi.fn() as never,
    windowIds: () => ['1'],
  })
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('account.list', () => {
  it('lists the default account first and marks the current one', async () => {
    store.use(WORK)
    expect(await call('account.list', undefined)).toEqual({
      ok: true,
      accounts: [
        { number: 1, email: 'me@example.com', current: false },
        { number: 2, email: 'work@example.com', current: true },
      ],
    })
    expect(registered.get('account.list')?.cap).toBe('settings-read')
  })

  it.each([
    ['sandboxed', { workspaceId: 'ws-sandbox' }],
    ['scratch', { workspaceId: 'ws-scratch' }],
    ['manager', { manager: true }],
  ])('shows no email to a %s pane, and names why', async (name, extra) => {
    expect(await call('account.list', undefined, ctx(extra))).toEqual({
      ok: false,
      error: name,
    })
  })
})

describe('account.switch', () => {
  it('asks the human on a card of its own kind and switches only when allowed once', async () => {
    expect(await call('account.switch', { target: '2' })).toEqual({
      ok: true,
      number: 2,
      email: 'work@example.com',
    })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'account-switch', caps: [], subject: 'work@example.com' }),
    )
    expect(store.current()).toBe(WORK)
  })

  it('does not switch when the human denies or does not answer', async () => {
    for (const outcome of ['deny', 'timeout']) {
      request.mockResolvedValueOnce(outcome)
      expect(await call('account.switch', { target: '2' })).toEqual({
        ok: false,
        error: 'not-approved',
      })
    }
    expect(store.current()).toBe('default')
  })

  it('does not switch without an approver or from a caller that is not a pane', async () => {
    hasApprover = false
    expect(await call('account.switch', { target: '2' })).toMatchObject({ error: 'not-approved' })
    hasApprover = true
    expect(await call('account.switch', { target: '2' }, ctx({ kind: 'extension' }))).toMatchObject(
      { error: 'not-approved' },
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('has no capability, so no Always allow of settings-write can skip the card', () => {
    expect(registered.get('account.switch')?.cap).toBeUndefined()
  })

  it('asks nothing for an unknown account or bad params, and refuses a sandboxed pane', async () => {
    expect(await call('account.switch', { target: 'nobody@example.com' })).toEqual({
      ok: false,
      error: 'unknown-account',
    })
    expect(await call('account.switch', {})).toEqual({ ok: false, error: 'invalid-params' })
    expect(
      await call('account.switch', { target: '2' }, ctx({ workspaceId: 'ws-sandbox' })),
    ).toEqual({ ok: false, error: 'sandboxed' })
    expect(request).not.toHaveBeenCalled()
  })
})

describe('claudeAccount.start', () => {
  it('answers the current profile folder to a plain pane', async () => {
    store.use(WORK)
    expect(await call('claudeAccount.start', { args: [] })).toEqual({
      dir: join(base, 'profiles', WORK),
    })
  })

  it.each([
    ['sandboxed', { workspaceId: 'ws-sandbox' }],
    ['scratch', { workspaceId: 'ws-scratch' }],
    ['manager', { manager: true }],
  ])('answers nothing to a %s pane', async (_name, extra) => {
    store.use(WORK)
    expect(await call('claudeAccount.start', { args: [] }, ctx(extra))).toEqual({ dir: '' })
  })

  it('needs no capability, so a Claude start is never held by an approval', () => {
    expect(registered.get('claudeAccount.start')?.cap).toBeUndefined()
  })

  it('ignores arguments that are not strings', async () => {
    expect(await call('claudeAccount.start', { args: [1, null, '--resume', 'x'] })).toEqual({
      dir: '',
    })
    expect(await call('claudeAccount.start', { args: 'nope' })).toEqual({ dir: '' })
  })
})

describe('remembering the account of a session', () => {
  it('stores the account the pane started on when the agent reports its session', async () => {
    store.use(WORK)
    await call('claudeAccount.start', { args: [] })
    store.use('default')
    vi.mocked(resolveExternal).mockReturnValue({ kind: 'pane', paneId: 'p1' } as never)
    resumeListener?.('ext-p1', { agent: 'claude', id: 'session-1' })
    expect(store.accountOfSession('session-1')).toBe(WORK)
  })

  it('ignores another agent’s session and a pane it cannot resolve', async () => {
    await call('claudeAccount.start', { args: [] })
    vi.mocked(resolveExternal).mockReturnValue({ kind: 'pane', paneId: 'p1' } as never)
    resumeListener?.('ext-p1', { agent: 'codex', id: 'session-2' })
    vi.mocked(resolveExternal).mockReturnValue(undefined)
    resumeListener?.('ext-p1', { agent: 'claude', id: 'session-3' })
    expect(store.accountOfSession('session-2')).toBeUndefined()
    expect(store.accountOfSession('session-3')).toBeUndefined()
  })
})

describe('the window channels', () => {
  const add = (workspaceId: unknown, event = windowEvent) =>
    ipc.get('claude-accounts:add')?.(event, workspaceId)

  it('open the login tab in the clicked window’s own plain terminal workspace', async () => {
    expect(await add('ws-1')).toBe('opened')
    expect(opened).toEqual([{ workspaceId: 'ws-1', windowId: '1' }])
  })

  it.each([
    ['another window’s workspace', 'ws-other'],
    ['a sandboxed one', 'ws-sandbox'],
    ['a scratch one', 'ws-scratch'],
    ['one that is not a terminal workspace', 'ws-browser'],
    ['an unknown one', 'ws-missing'],
    ['none', null],
  ])('refuse to add in %s, and open nothing', async (_name, workspaceId) => {
    mkdirSync(join(base, 'profiles'), { recursive: true })
    expect(await add(workspaceId)).toBe('no-workspace')
    expect(opened).toEqual([])
  })

  it('answer only a window, never a guest page', async () => {
    expect(await ipc.get('claude-accounts:state')?.(guestEvent)).toMatchObject({
      accounts: [{ id: 'default' }],
    })
    expect(await ipc.get('claude-accounts:use')?.(guestEvent, WORK)).toBe(false)
    expect(await ipc.get('claude-accounts:remove')?.(guestEvent, WORK)).toBe('unknown')
    expect(await add('ws-1', guestEvent as never)).toBe('not-opened')
    expect(await ipc.get('claude-accounts:recover')?.(guestEvent)).toBeNull()
    expect(store.current()).toBe('default')
  })

  it('use, remove and answer what happened', async () => {
    expect(await ipc.get('claude-accounts:use')?.(windowEvent, WORK)).toBe(true)
    expect(await ipc.get('claude-accounts:remove')?.(windowEvent, 7)).toBe('unknown')
    expect(await ipc.get('claude-accounts:remove')?.(windowEvent, WORK)).toBe('removed')
  })
})

describe('a damaged store', () => {
  it('keeps every profile folder and answers damaged until the human recovers', async () => {
    const file = join(base, 'damaged.json')
    writeFileSync(file, '{')
    const folder = join(base, 'profiles-kept', 'c'.repeat(16))
    mkdirSync(folder, { recursive: true })
    const damaged = new ClaudeAccounts({
      store: new ClaudeAccountsStore(file),
      root: join(base, 'profiles-kept'),
      defaultHome: () => join(base, 'home'),
      defaultEmail: async () => null,
      profileEmail: async () => null,
      syncProfile: async () => {},
      agentRunning: () => false,
      openLoginTab: async () => 'pane',
      onChange: () => {},
      now: () => Date.now() + 24 * 60 * 60 * 1000,
    })
    registered.clear()
    ipc.clear()
    registerClaudeAccountsWiring({
      claudeAccounts: damaged,
      agentResumes: { subscribe: () => {} } as never,
      workspaceSandboxes: { isEnabled: () => false },
      scratchFolders: { isScratch: () => false },
      workspaceWindowId: () => '1',
      execCommand: vi.fn() as never,
      windowIds: () => ['1'],
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(existsSync(folder)).toBe(true)
    expect(await ipc.get('claude-accounts:add')?.(windowEvent, 'ws-1')).toBe('damaged')
    expect(await ipc.get('claude-accounts:recover')?.(guestEvent)).toBeNull()
    expect(await ipc.get('claude-accounts:recover')?.(windowEvent)).toBe(0)
    expect(existsSync(folder)).toBe(true)
  })
})
