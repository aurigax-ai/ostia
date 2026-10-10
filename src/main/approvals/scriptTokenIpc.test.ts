import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScriptTokenSaveResult } from '../../shared/permissions/scriptTokens'
import type { ReachListing } from './reach'
import type { PresenceRequest } from './scriptTokens'
import type { PresenceResult } from './userPresence'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const owners = vi.hoisted(() => new Map<unknown, unknown>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  BrowserWindow: { fromWebContents: (wc: unknown) => owners.get(wc) ?? null },
}))
vi.mock('./approvals', () => ({ approvals: () => null }))

const { registerScriptTokenIpc } = await import('./scriptTokenIpc')
const { setUserPresenceCheck, verifyScriptToken } = await import('./scriptTokens')

const LISTING: ReachListing = {
  workspaces: [
    { workspaceId: 'w1', name: 'ostia', workDir: '/w1', groupId: 'g1' },
    { workspaceId: 'w2', name: 'homelab', workDir: '/w2' },
  ],
  groups: [{ groupId: 'g1', name: 'AurigaX', color: 'purple' }],
}
const COORDINATOR = [
  'read-board',
  'read-other-pane',
  'send-other-pane',
  'type-other-pane',
  'process',
  'notify',
]
const LIMITED = { kind: 'limited', groups: ['g1'], workspaces: [], ownWorkspaces: true }

let dir = ''
let path = ''
const changed = vi.fn()
const presence = vi.fn(
  async (_r: PresenceRequest): Promise<PresenceResult> => ({
    ok: true,
    via: 'touch-id',
  }),
)

function sender(win: unknown) {
  const mainFrame = { url: 'app://index.html' }
  const wc = { mainFrame }
  owners.set(wc, win)
  return { sender: wc, senderFrame: mainFrame }
}

const appWindow = { id: 'app' }
const otherWindow = { id: 'telemetry' }
const fromApp = sender(appWindow)

registerScriptTokenIpc({
  path: () => path,
  retiredPath: () => join(dir, 'retired.json'),
  listing: async () => LISTING,
  changed,
  appWindows: () => [appWindow as never],
})

function callAs<T>(event: unknown, channel: string, ...args: unknown[]): Promise<T> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return Promise.resolve().then(() => fn(event, ...args) as T)
}

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return callAs(fromApp, channel, ...args)
}

const list = () => call<{ tokens: Record<string, unknown>[] }>('scriptTokens:list')
const create = (input: unknown) => call<ScriptTokenSaveResult>('scriptTokens:create', input)
const update = (input: unknown) => call<ScriptTokenSaveResult>('scriptTokens:update', input)

async function created(input: Record<string, unknown> = {}) {
  const res = await create({
    name: 'ceo',
    caps: COORDINATOR,
    scope: LIMITED,
    expires: '90d',
    ...input,
  })
  if (!res.ok || !res.value) throw new Error(`create failed: ${JSON.stringify(res)}`)
  return { token: res.token, value: res.value }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'script-token-ipc-'))
  path = join(dir, 'script-tokens-v2.json')
  changed.mockClear()
  presence.mockClear()
  presence.mockImplementation(async () => ({ ok: true, via: 'touch-id' }))
  setUserPresenceCheck(presence)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('script token IPC', () => {
  it('handles exactly list, create, update and revoke', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'scriptTokens:create',
      'scriptTokens:list',
      'scriptTokens:revoke',
      'scriptTokens:update',
    ])
  })

  it.each([
    ['a subframe of an Ostia window', { ...sender(appWindow), senderFrame: { url: 'x' } }],
    ['a sender without a frame', { ...sender(appWindow), senderFrame: null }],
    ['another window', sender(otherWindow)],
    ['a guest page with no window', sender(null)],
  ])('refuses every channel from %s', async (_what, event) => {
    const { token, value } = await created()
    presence.mockClear()
    for (const [channel, arg] of [
      ['scriptTokens:list', undefined],
      ['scriptTokens:create', { name: 'x', caps: ['read-board'], scope: LIMITED, expires: '7d' }],
      ['scriptTokens:update', { id: token.id, ifUpdatedAt: token.updatedAt, caps: ['notify'] }],
      ['scriptTokens:revoke', token.id],
    ] as const) {
      await expect(callAs(event, channel, arg)).rejects.toThrow(/^forbidden/)
    }
    expect(presence).not.toHaveBeenCalled()
    expect(verifyScriptToken(path, value)?.caps).toEqual(token.caps)
    expect((await list()).tokens).toHaveLength(1)
  })

  it('is the only way the preload reaches script tokens', () => {
    const preload = readFileSync(join(__dirname, '..', '..', 'preload', 'index.ts'), 'utf8')
    const block = /\n {2}scriptTokens: \{\n([\s\S]*?)\n {2}\},\n/.exec(preload)?.[1] ?? ''
    const channels = [...block.matchAll(/ipcRenderer\.(\w+)\('([^']+)'/g)].map((m) => m[2])
    expect(channels.sort()).toEqual([
      'scriptTokens:changed',
      'scriptTokens:changed',
      'scriptTokens:create',
      'scriptTokens:list',
      'scriptTokens:revoke',
      'scriptTokens:update',
    ])
    expect(preload.match(/scriptTokens:/g)).toHaveLength(channels.length + 1)
  })

  it('confirms presence before generating, then shows the value once and stores only a hash', async () => {
    const { token, value } = await created()
    expect(presence).toHaveBeenCalledWith({ action: 'generate', name: 'ceo' })
    expect(token).toMatchObject({ name: 'ceo', source: 'settings', scope: LIMITED })
    expect(verifyScriptToken(path, value)?.id).toBe(token.id)
    expect(readFileSync(path, 'utf8')).not.toContain(value)
    const { tokens } = await list()
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).not.toHaveProperty('hash')
    expect(tokens[0]).not.toHaveProperty('token')
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('lists the workspaces and groups the dialog picks from', async () => {
    await expect(call('scriptTokens:list')).resolves.toMatchObject({
      tokens: [],
      retired: [],
      workspaces: [
        { id: 'w1', name: 'ostia', groupId: 'g1' },
        { id: 'w2', name: 'homelab' },
      ],
      groups: [{ id: 'g1', name: 'AurigaX', color: 'purple' }],
    })
  })

  it.each<[string, PresenceResult, string]>([
    ['cancelled', { ok: false, code: 'cancelled', detail: 'dismissed' }, 'cancelled'],
    ['refused', { ok: false, code: 'failed', detail: 'Touch ID did not confirm' }, 'refused'],
    [
      'without a polkit agent',
      { ok: false, code: 'unavailable', detail: 'no agent', hint: 'polkit-agent' },
      'polkit-agent',
    ],
  ])('generates nothing when presence is %s', async (_what, result, kind) => {
    presence.mockResolvedValueOnce(result)
    const res = await create({ name: 'ceo', caps: ['read-board'], scope: LIMITED, expires: '7d' })
    expect(res).toMatchObject({ ok: false, presence: kind })
    expect(res).not.toHaveProperty('value')
    expect((await list()).tokens).toEqual([])
    expect(changed).not.toHaveBeenCalled()
  })

  it.each([
    ['a capability scripts may not hold', { caps: ['settings-write'] }],
    ['an unknown capability', { caps: ['shell'] }],
    ['no capability', { caps: [] }],
    ['never expiring without the confirmation', { expires: 'never' }],
    ['an empty limited scope', { scope: { kind: 'limited', groups: [], workspaces: [] } }],
    ['a group that does not exist', { scope: { kind: 'limited', groups: ['nope'] } }],
    ['a bad name', { name: '' }],
  ])('refuses %s without asking for presence', async (_what, over) => {
    const res = await create({
      name: 'ceo',
      caps: ['read-board'],
      scope: LIMITED,
      expires: '90d',
      ...over,
    })
    expect(res.ok).toBe(false)
    expect(presence).not.toHaveBeenCalled()
    expect((await list()).tokens).toEqual([])
  })

  it('takes the source from main, not from the renderer', async () => {
    const { token } = await created({ source: 'cli', id: 'script_mine', hash: 'x' })
    expect(token.source).toBe('settings')
    expect(token.id).not.toBe('script_mine')
  })

  it('generates a token that never expires only with the confirmation', async () => {
    const { token } = await created({ expires: 'never', confirmNeverExpires: true })
    expect(token.expiresAt).toBeNull()
  })

  it('renames without asking for presence and keeps the value', async () => {
    const { token, value } = await created()
    presence.mockClear()
    const res = await update({ id: token.id, ifUpdatedAt: token.updatedAt, name: 'ceo-2' })
    expect(res).toMatchObject({ ok: true, token: { name: 'ceo-2' } })
    expect(res).not.toHaveProperty('value')
    expect(presence).not.toHaveBeenCalled()
    expect(verifyScriptToken(path, value)?.name).toBe('ceo-2')
  })

  it('regenerates after presence when permissions, scope or expiry change', async () => {
    for (const change of [
      { caps: ['read-board'] },
      { scope: { kind: 'all' } },
      { expires: '7d' },
    ]) {
      const { token, value } = await created()
      presence.mockClear()
      const res = await update({ id: token.id, ifUpdatedAt: token.updatedAt, ...change })
      expect(presence).toHaveBeenCalledWith({ action: 'regenerate', name: 'ceo' })
      if (!res.ok || !res.value) throw new Error(JSON.stringify(res))
      expect(verifyScriptToken(path, value)).toBeUndefined()
      expect(verifyScriptToken(path, res.value)?.id).toBe(token.id)
    }
  })

  it('keeps the old value when presence fails on a regenerate', async () => {
    const { token, value } = await created()
    presence.mockResolvedValueOnce({ ok: false, code: 'cancelled', detail: 'dismissed' })
    const res = await update({ id: token.id, ifUpdatedAt: token.updatedAt, caps: ['read-board'] })
    expect(res).toMatchObject({ ok: false, presence: 'cancelled' })
    expect(verifyScriptToken(path, value)?.caps).toEqual(token.caps)
  })

  it('refuses a stale edit or a name in place of the id before asking for presence', async () => {
    const { token } = await created()
    presence.mockClear()
    const stale = await update({ id: token.id, ifUpdatedAt: 'then', caps: ['read-board'] })
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/^conflict/) })
    const byName = await update({ id: 'ceo', ifUpdatedAt: token.updatedAt, caps: ['read-board'] })
    expect(byName).toMatchObject({ ok: false, error: expect.stringMatching(/^unknown-token/) })
    expect(presence).not.toHaveBeenCalled()
  })

  it('revokes at once and reports unknown ids', async () => {
    const { token, value } = await created()
    changed.mockClear()
    await expect(call('scriptTokens:revoke', token.id)).resolves.toBe(true)
    expect(verifyScriptToken(path, value)).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(1)
    await expect(call('scriptTokens:revoke', token.id)).resolves.toBe(false)
    await expect(call('scriptTokens:revoke', { id: token.id })).resolves.toBe(false)
  })
})
