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

import type { AccountUsage } from '../../../shared/claudeAccounts/claudeAccounts'
import { ClaudeAccountsStore } from './accountsStore'
import { ClaudeAccounts, type LoginTarget } from './claudeAccounts'
import { registerClaudeAccountsWiring } from './claudeAccountsWiring'

const WORK = 'a'.repeat(16)
const windowEvent = { sender: { getType: () => 'window', id: 1 } }
const guestEvent = { sender: { getType: () => 'webview', id: 1 } }

let switched: ReturnType<typeof vi.fn<() => Promise<void>>>
let sandboxed: Set<string>
let scratch: Set<string>
let store: ClaudeAccountsStore
let opened: LoginTarget[]
let usage: Map<string, AccountUsage>
let usageRuns: boolean[]
let trusted: { dir: string; paneId: string }[]
let asked: string[]
let release: (() => void) | null
let holdAsk = false

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
  usage = new Map()
  usageRuns = []
  trusted = []
  asked = []
  release = null
  holdAsk = false
  switched = vi.fn<() => Promise<void>>(async () => {})
  base = mkdtempSync(join(tmpdir(), 'ostia-accounts-wiring-'))
  store = new ClaudeAccountsStore(join(base, 'accounts.json'))
  store.add({ id: WORK, email: 'work@example.com', addedAt: 1 })
  const claudeAccounts = new ClaudeAccounts({
    store,
    root: join(base, 'profiles'),
    defaultHome: () => join(base, 'home'),
    defaultLogin: async () => ({ uuid: null, email: 'me@example.com' }),
    profileLogin: async () => null,
    loginState: async () => 'signed-in',
    writeLogin: async () => true,
    signIn: null,
    usage: {
      run: (on) => usageRuns.push(on),
      usageOf: (id) => usage.get(id) ?? null,
    },
    syncProfile: async () => {},
    agentRunning: () => false,
    paneOf: (id) => id,
    openLoginTab: async (_dir, target) => {
      opened.push(target)
      return 'login-pane'
    },
    onChange: () => {},
  })
  registerClaudeAccountsWiring({
    claudeAccounts,
    accountMoves: { switched },
    workspaceSandboxes: { isEnabled: (id: string) => sandboxed.has(id) },
    scratchFolders: { isScratch: (id: string) => scratch.has(id) },
    workspaceWindowId: (id: string) => (id === 'ws-other' ? '2' : '1'),
    execCommand: vi.fn() as never,
    windowIds: () => ['1'],
    trustForStart: async (dir, identity) => {
      trusted.push({ dir, paneId: identity.paneId })
      return true
    },
    askTrust: async (dir, identity) => {
      asked.push(`${dir}|${identity.paneId}`)
      await new Promise<void>((resolve) => {
        release = resolve
        if (!holdAsk) resolve()
      })
    },
  })
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('account.list', () => {
  it('lists the default account first and marks the current one', async () => {
    store.use(WORK)
    expect(await call('account.list', undefined)).toEqual({
      ok: true,
      accounts: [
        {
          number: 1,
          email: 'me@example.com',
          current: false,
          enabled: true,
          session: null,
          weekly: null,
        },
        {
          number: 2,
          email: 'work@example.com',
          current: true,
          enabled: true,
          session: null,
          weekly: null,
        },
      ],
    })
    expect(registered.get('account.list')?.cap).toBe('settings-read')
  })

  it('adds the session and weekly percent once usage was checked, a reset window at 0', async () => {
    const later = Date.now() + 3_600_000
    usage.set(WORK, {
      session: { percent: 41.6, resetsAt: Date.now() - 1 },
      weekly: { percent: 18.2, resetsAt: later },
      checkedAt: 1,
    })
    expect(await call('account.list', undefined)).toMatchObject({
      accounts: [
        { number: 1, session: null, weekly: null },
        { number: 2, session: 0, weekly: 18 },
      ],
    })
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

  it('refuses an account that is turned off without asking the human', async () => {
    store.setEnabled(WORK, false)
    expect(await call('account.switch', { target: 'work@example.com' })).toEqual({
      ok: false,
      error: 'account-off',
    })
    expect(request).not.toHaveBeenCalled()
    expect(store.current()).toBe('default')
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
    expect(await call('claudeAccount.start', {})).toEqual({
      dir: join(base, 'profiles', WORK),
      memoryHome: join(base, 'home'),
    })
  })

  it.each([
    ['sandboxed', { workspaceId: 'ws-sandbox' }],
    ['scratch', { workspaceId: 'ws-scratch' }],
    ['manager', { manager: true }],
  ])('answers nothing to a %s pane', async (_name, extra) => {
    store.use(WORK)
    expect(await call('claudeAccount.start', {}, ctx(extra))).toEqual({ dir: '', memoryHome: '' })
  })

  it('prepares trust for the profile folder it answers', async () => {
    store.use(WORK)
    await call('claudeAccount.start', {})
    expect(trusted).toEqual([{ dir: join(base, 'profiles', WORK), paneId: 'p1' }])
  })

  it('prepares trust in the Default account’s config while it is current', async () => {
    await call('claudeAccount.start', {})
    expect(trusted).toEqual([{ dir: '', paneId: 'p1' }])
  })

  it.each([
    ['sandboxed', { workspaceId: 'ws-sandbox' }],
    ['scratch', { workspaceId: 'ws-scratch' }],
    ['manager', { manager: true }],
  ])('prepares trust for a %s pane against the Default account only', async (_name, extra) => {
    store.use(WORK)
    await call('claudeAccount.start', {}, ctx(extra))
    expect(trusted).toEqual([{ dir: '', paneId: 'p1' }])
  })

  it('CFT-C90 asks the human after preparing trust and answers only when the ask is done', async () => {
    store.use(WORK)
    holdAsk = true
    let answered = false
    const call1 = Promise.resolve(call('claudeAccount.start', {})).then((r: unknown) => {
      answered = true
      return r
    })
    await vi.waitFor(() => expect(asked).toEqual([`${join(base, 'profiles', WORK)}|p1`]))
    expect(trusted).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 30))
    expect(answered).toBe(false)
    release?.()
    expect(await call1).toMatchObject({ dir: join(base, 'profiles', WORK) })
  })

  it('needs no capability, so a Claude start is never held by an approval', () => {
    expect(registered.get('claudeAccount.start')?.cap).toBeUndefined()
  })

  it('answers the current account to a resume too, whatever the arguments say', async () => {
    store.use(WORK)
    expect(await call('claudeAccount.start', { args: ['--resume', 'x'] })).toEqual({
      dir: join(base, 'profiles', WORK),
      memoryHome: join(base, 'home'),
    })
  })
})

describe('moving sessions on a switch', () => {
  it('CLA-M6 moves the running sessions after a switch from a window', async () => {
    expect(await ipc.get('claude-accounts:use')?.(windowEvent, WORK)).toBe(true)
    expect(switched).toHaveBeenCalledTimes(1)
  })

  it('moves them after a switch the human allowed on the card', async () => {
    await call('account.switch', { target: '2' })
    expect(switched).toHaveBeenCalledTimes(1)
  })

  it('moves nothing when no switch happened', async () => {
    await ipc.get('claude-accounts:use')?.(guestEvent, WORK)
    request.mockResolvedValueOnce('deny')
    await call('account.switch', { target: '2' })
    store.setEnabled(WORK, false)
    await ipc.get('claude-accounts:use')?.(windowEvent, WORK)
    await call('account.switch', { target: '2' })
    expect(switched).not.toHaveBeenCalled()
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
    expect(await ipc.get('claude-accounts:set-check-usage')?.(guestEvent, true)).toBe(false)
    expect(await ipc.get('claude-accounts:set-enabled')?.(guestEvent, WORK, false)).toBe('unknown')
    expect(store.isEnabled(WORK)).toBe(true)
    expect(store.current()).toBe('default')
    expect(store.checkUsage()).toBe(false)
  })

  it('use, remove and answer what happened', async () => {
    expect(await ipc.get('claude-accounts:use')?.(windowEvent, WORK)).toBe(true)
    expect(await ipc.get('claude-accounts:remove')?.(windowEvent, 7)).toBe('unknown')
    expect(await ipc.get('claude-accounts:remove')?.(windowEvent, WORK)).toBe('removed')
  })

  it('turns an account off and on from a window, never with a value that is not a boolean', async () => {
    expect(await ipc.get('claude-accounts:set-enabled')?.(windowEvent, WORK, 'no')).toBe('unknown')
    expect(await ipc.get('claude-accounts:set-enabled')?.(windowEvent, WORK, false)).toBe('done')
    expect(store.isEnabled(WORK)).toBe(false)
    expect(await ipc.get('claude-accounts:use')?.(windowEvent, WORK)).toBe(false)
  })

  it('turns the usage check on and off only for a boolean from a window', async () => {
    expect(await ipc.get('claude-accounts:set-check-usage')?.(windowEvent, 'yes')).toBe(false)
    expect(await ipc.get('claude-accounts:set-check-usage')?.(windowEvent, true)).toBe(true)
    expect(store.checkUsage()).toBe(true)
    expect(usageRuns.at(-1)).toBe(true)
    expect(await ipc.get('claude-accounts:set-check-usage')?.(windowEvent, false)).toBe(true)
    expect(usageRuns.at(-1)).toBe(false)
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
      defaultLogin: async () => null,
      profileLogin: async () => null,
      loginState: async () => 'signed-in',
      writeLogin: async () => true,
      signIn: null,
      usage: null,
      syncProfile: async () => {},
      agentRunning: () => false,
      paneOf: (id) => id,
      openLoginTab: async () => 'pane',
      onChange: () => {},
      now: () => Date.now() + 24 * 60 * 60 * 1000,
    })
    registered.clear()
    ipc.clear()
    registerClaudeAccountsWiring({
      claudeAccounts: damaged,
      accountMoves: { switched: async () => {} },
      workspaceSandboxes: { isEnabled: () => false },
      scratchFolders: { isScratch: () => false },
      workspaceWindowId: () => '1',
      execCommand: vi.fn() as never,
      trustForStart: async () => false,
      askTrust: async () => undefined,
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

describe('sign-in IPC', () => {
  const channels = [
    ['claude-accounts:begin-sign-in', [null], 'unavailable'],
    ['claude-accounts:open-sign-in', [], false],
    ['claude-accounts:submit-code', ['abcdefghijklmnop0123'], 'idle'],
  ] as const

  it.each(channels)('%s answers a guest page with nothing', async (channel, args, nothing) => {
    expect(await ipc.get(channel)?.(guestEvent, ...args)).toBe(nothing)
  })

  it('refuses a begin whose target is neither null nor an id', async () => {
    expect(await ipc.get('claude-accounts:begin-sign-in')?.(windowEvent, 5)).toBe('unavailable')
    expect(await ipc.get('claude-accounts:begin-sign-in')?.(windowEvent, { id: 'x' })).toBe(
      'unavailable',
    )
  })

  it('is unavailable where the service has no sign-in', async () => {
    expect(await ipc.get('claude-accounts:begin-sign-in')?.(windowEvent, null)).toBe('unavailable')
  })

  it('is not reachable from a socket method, the CLI or an agent', () => {
    expect([...registered.keys()].filter((name) => /sign/i.test(name))).toEqual([])
  })
})
