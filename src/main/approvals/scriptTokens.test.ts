import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import { type Capability, DEFAULT_CAPABILITIES } from '../../shared/capabilities'
import type { ApprovalOutcome } from '../../shared/permissions/approvals'
import { SCRIPT_CAPABILITIES } from '../../shared/permissions/scriptTokens'
import type { CommandResult } from '../../shared/types'

let answer: ApprovalOutcome = 'deny'
const request = vi.fn(async () => answer)

vi.mock('./approvals', () => ({ approvals: () => ({ request }) }))

const { setCapFilter, setScriptTokenCheck } = await import('../control/controlAuth')
const { SCRIPT_COMMANDS } = await import('../control/commandArgs')
const { registerControlMethod, registerControlServer, stopControlServer } = await import(
  '../control/controlServer'
)
const { markManager, registerPane } = await import('../control/idRegistry')
const { registerDocsMethods } = await import('../control/docs')
const {
  createScriptToken,
  listScriptTokens,
  parseTokenRequest,
  registerScriptTokenMethods,
  revokeScriptToken,
  verifyScriptToken,
} = await import('./scriptTokens')

const dirs: string[] = []
let storeFile = ''

function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'script-tokens-'))
  dirs.push(dir)
  return join(dir, 'script-tokens.json')
}

registerScriptTokenMethods(() => storeFile)
registerDocsMethods({ extensions: () => [] })
setScriptTokenCheck((token) => verifyScriptToken(storeFile, token))
registerControlMethod('test.scriptsOpen', {
  cap: 'read-board',
  scripts: true,
  handler: (_params, ctx) => ({ kind: ctx.identity.kind }),
})
registerControlMethod('test.scriptsWrite', {
  cap: 'type-other-pane',
  scripts: true,
  handler: () => ({ ok: true }),
})
registerControlMethod('test.panesOnly', {
  callers: 'all',
  handler: () => ({ ok: true }),
})

let socketPath = ''
let seq = 0
const clients: MessageConnection[] = []

async function client(token: string): Promise<MessageConnection> {
  const socket = createConnection(socketPath)
  const conn = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  conn.listen()
  clients.push(conn)
  await conn.sendRequest('hello', { token })
  return conn
}

beforeEach(() => {
  seq += 1
  storeFile = tempStore()
  socketPath = join(tmpdir(), `ostia-script-${process.pid}-${seq}.sock`)
  registerControlServer(
    {
      execCommand: async () => ({ ok: true }) as CommandResult,
      listCommandsFor: () => [],
      getTerminalState: () => undefined,
      isSandboxed: () => false,
    },
    socketPath,
  )
  answer = 'deny'
  request.mockClear()
  setCapFilter(() => true)
})

afterEach(() => {
  for (const c of clients.splice(0)) c.dispose()
  stopControlServer()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('script token store', () => {
  it('keeps only a hash on disk, private to the user, and verifies the token', () => {
    const created = createScriptToken(storeFile, 'dispatcher', ['read-board', 'type-other-pane'])

    expect(created.token).toMatch(/^ostia_[0-9a-f]{64}$/)
    expect(created.id).toMatch(/^script_/)
    const raw = readFileSync(storeFile, 'utf8')
    expect(raw).not.toContain(created.token)
    expect(statSync(storeFile).mode & 0o777).toBe(0o600)
    expect(verifyScriptToken(storeFile, created.token)).toMatchObject({
      id: created.id,
      caps: ['read-board', 'type-other-pane'],
    })
    const last = created.token.endsWith('0') ? '1' : '0'
    expect(verifyScriptToken(storeFile, `${created.token.slice(0, -1)}${last}`)).toBeUndefined()
    expect(verifyScriptToken(storeFile, created.token.slice(6))).toBeUndefined()
  })

  it('lists tokens without their values and revokes them', () => {
    const created = createScriptToken(storeFile, 'board', ['read-board'])
    expect(listScriptTokens(storeFile)).toEqual([
      { id: created.id, name: 'board', caps: ['read-board'], createdAt: expect.any(String) },
    ])
    expect(JSON.stringify(listScriptTokens(storeFile))).not.toContain('hash')
    expect(revokeScriptToken(storeFile, created.id)).toBe(true)
    expect(revokeScriptToken(storeFile, created.id)).toBe(false)
    expect(verifyScriptToken(storeFile, created.token)).toBeUndefined()
  })

  it('drops capabilities a script token may not hold when the file was edited by hand', () => {
    const created = createScriptToken(storeFile, 'x', ['read-board'])
    const store = JSON.parse(readFileSync(storeFile, 'utf8'))
    store[created.id].caps = ['read-board', 'destructive', 'settings-write']
    writeFileSync(storeFile, JSON.stringify(store))
    expect(verifyScriptToken(storeFile, created.token)?.caps).toEqual(['read-board'])
  })

  it('refuses bad names and capabilities outside the script set', () => {
    expect(parseTokenRequest({ name: ' cron ', caps: ['read-board'] })).toEqual({
      name: 'cron',
      caps: ['read-board'],
    })
    expect(() => parseTokenRequest({ name: '', caps: ['read-board'] })).toThrow('name')
    expect(() => parseTokenRequest({ name: 'a\nb', caps: ['read-board'] })).toThrow('name')
    expect(() => parseTokenRequest({ name: 'x', caps: [] })).toThrow('caps')
    expect(() => parseTokenRequest({ name: 'x', caps: ['destructive'] })).toThrow('can hold only')
  })

  it('lets a token hold process, send-other-pane, kill-pane and notify, but never shell', () => {
    expect(
      parseTokenRequest({
        name: 'cron',
        caps: ['notify', 'process', 'send-other-pane', 'all-workspaces', 'kill-pane'],
      }),
    ).toEqual({
      name: 'cron',
      caps: ['all-workspaces', 'process', 'send-other-pane', 'kill-pane', 'notify'],
    })
    expect(() => parseTokenRequest({ name: 'x', caps: ['shell'] })).toThrow('can hold only')
    expect(() => parseTokenRequest({ name: 'x', caps: ['destructive'] })).toThrow('can hold only')
  })
})

describe('script callers on the control socket', () => {
  it('reaches only methods open to scripts, with exactly the token capabilities', async () => {
    const { token } = createScriptToken(storeFile, 'board', ['read-board'])
    const conn = await client(token)

    expect(await conn.sendRequest('whoami')).toMatchObject({ kind: 'script' })
    expect(await conn.sendRequest('test.scriptsOpen')).toEqual({ kind: 'script' })
    await expect(conn.sendRequest('test.scriptsWrite')).rejects.toThrow(
      'needs-elevation: type-other-pane',
    )
    await expect(conn.sendRequest('test.panesOnly')).rejects.toThrow('not-available-to-script')
    expect(request).not.toHaveBeenCalled()
  })

  it('reads the CLI reference', async () => {
    const conn = await client(createScriptToken(storeFile, 'docs', ['read-board']).token)
    const res = await conn.sendRequest<{ cli: string }>('docs')
    expect(res.cli).toContain('Scripts reach only these methods')
    expect(res.cli).not.toContain('Manager only')
  })

  it('refuses an unknown token and cuts a revoked one off at once', async () => {
    const socket = createConnection(socketPath)
    const bad = createMessageConnection(
      new StreamMessageReader(socket),
      new StreamMessageWriter(socket),
    )
    bad.listen()
    clients.push(bad)
    await expect(bad.sendRequest('hello', { token: 'ostia_nope' })).rejects.toThrow(
      'invalid or missing token',
    )

    const created = createScriptToken(storeFile, 'cron', ['read-board'])
    const conn = await client(created.token)
    await conn.sendRequest('test.scriptsOpen')
    const owner = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'token-owner' })
    answer = 'once'
    const admin = await client(owner.token)
    await admin.sendRequest('token.revoke', { id: created.id })
    await expect(conn.sendRequest('test.scriptsOpen')).rejects.toThrow('unknown identity')
  })

  it('creates a token from a pane only after the human approves it', async () => {
    const pane = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'token-maker' })
    const conn = await client(pane.token)

    await expect(
      conn.sendRequest('token.create', { name: 'cron', caps: ['type-other-pane'] }),
    ).rejects.toThrow('denied: settings-write, type-other-pane')
    expect(listScriptTokens(storeFile)).toEqual([])

    answer = 'once'
    const created = await conn.sendRequest<{ token: string; caps: string[] }>('token.create', {
      name: 'cron',
      caps: ['read-board'],
    })
    expect(created.caps).toEqual(['read-board'])
    expect(request).toHaveBeenCalledTimes(2)
    const script = await client(created.token)
    expect(await script.sendRequest('test.scriptsOpen')).toEqual({ kind: 'script' })
  })

  it('does not let a script manage tokens', async () => {
    const { token } = createScriptToken(storeFile, 'board', ['read-board'])
    const conn = await client(token)
    await expect(
      conn.sendRequest('token.create', { name: 'more', caps: ['type-other-pane'] }),
    ).rejects.toThrow('not-available-to-script')
  })
})

describe('script tokens on command.exec', () => {
  const descriptor = (id: string, capabilities: string[], target = 'active') => ({
    id,
    title: id,
    category: null,
    hidden: false,
    argsSchema: null,
    resultSchema: null,
    capabilities,
    target,
  })
  const COMMANDS = [
    descriptor('workspace.new', DEFAULT_CAPABILITIES, 'none'),
    descriptor('pane.close', ['kill-pane']),
    descriptor('workspace.close', ['kill-pane']),
    descriptor('workspace.closeOthers', ['kill-pane']),
    descriptor('tab.new', []),
    descriptor('workspace.group', ['drive-self']),
    descriptor('workspace.ungroup', ['drive-self']),
    descriptor('workspace.describe', ['drive-self']),
    descriptor('workspace.groupColor', ['drive-self'], 'none'),
    descriptor('workspace.newScratch', DEFAULT_CAPABILITIES, 'none'),
    descriptor('workspace.hibernateAgents', ['kill-pane']),
    descriptor('workspace.hibernateGroupAgents', ['kill-pane']),
    descriptor('workspace.resumeAgents', ['type-other-pane']),
    descriptor('workspace.resumeGroupAgents', ['type-other-pane']),
    descriptor('workspace.deleteGroup', DEFAULT_CAPABILITIES),
    descriptor('settings.set', ['settings-write']),
    descriptor('workspace.goto', DEFAULT_CAPABILITIES),
  ]
  const WS2 = { workspaceId: 'ws2', paneId: null }
  const inWs2 = { windowId: 'w1', workspaceId: 'ws2', paneId: null }
  let executed: { target: unknown; id: string; args: unknown }[] = []

  beforeEach(() => {
    executed = []
    stopControlServer()
    registerControlServer(
      {
        execCommand: async (target, id, args) => {
          executed.push({ target, id, args })
          return { ok: true, result: { workspaceId: 'ws-new' } } as CommandResult
        },
        listCommandsFor: (windowId) => (windowId === 'w1' ? (COMMANDS as never) : []),
        getTerminalState: (paneId) =>
          paneId === 'inner-info'
            ? { paneId, generation: 1, cwd: '/w', running: true, blockCount: 2 }
            : undefined,
        isSandboxed: () => false,
        windowOfWorkspace: (workspaceId) => (workspaceId === 'ws2' ? 'w1' : undefined),
        primaryWindow: () => 'w1',
      },
      socketPath,
    )
  })

  it('creates a workspace in the primary window when the token holds all-workspaces', async () => {
    const { token } = createScriptToken(storeFile, 'f5', ['all-workspaces'])
    const conn = await client(token)
    const res = await conn.sendRequest<CommandResult>('command.exec', {
      id: 'workspace.new',
      args: { name: 'W-two', focus: false },
    })
    expect(res).toEqual({ ok: true, result: { workspaceId: 'ws-new' } })
    expect(executed).toEqual([
      {
        target: { windowId: 'w1', workspaceId: '', paneId: null },
        id: 'workspace.new',
        args: { name: 'W-two', focus: false },
      },
    ])
  })

  it('refuses workspace.new without all-workspaces and never asks the human', async () => {
    const { token } = createScriptToken(storeFile, 'f5', ['process'])
    const conn = await client(token)
    await expect(conn.sendRequest('command.exec', { id: 'workspace.new' })).rejects.toThrow(
      'needs-elevation: all-workspaces',
    )
    await expect(
      conn.sendRequest('command.exec', { id: 'workspace.new', args: { focus: false } }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    expect(executed).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })

  it('lets an in-app pane token run workspace.new with its default capabilities', async () => {
    const me = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'pane-ws-new' })
    const conn = await client(me.token)
    const res = await conn.sendRequest<CommandResult>('command.exec', { id: 'workspace.new' })
    expect(res).toEqual({ ok: true, result: { workspaceId: 'ws-new' } })
    expect(request).not.toHaveBeenCalled()
  })

  it('closes a pane named by its pane.list id, in that pane workspace, with kill-pane', async () => {
    const target = registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'inner-close-1' })
    const { token } = createScriptToken(storeFile, 'f5', ['all-workspaces', 'kill-pane'])
    const conn = await client(token)
    await conn.sendRequest('command.exec', {
      id: 'pane.close',
      args: { paneId: target.externalId },
    })
    expect(executed).toEqual([
      {
        target: { windowId: 'w1', workspaceId: 'ws2', paneId: null },
        id: 'pane.close',
        args: { paneId: 'inner-close-1' },
      },
    ])
  })

  it('refuses pane.close without kill-pane or without all-workspaces', async () => {
    const target = registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'inner-close-2' })
    const noKill = await client(createScriptToken(storeFile, 'a', ['all-workspaces']).token)
    await expect(
      noKill.sendRequest('command.exec', { id: 'pane.close', args: { paneId: target.externalId } }),
    ).rejects.toThrow('needs-elevation: kill-pane')
    const noReach = await client(createScriptToken(storeFile, 'b', ['kill-pane']).token)
    await expect(
      noReach.sendRequest('command.exec', {
        id: 'pane.close',
        args: { paneId: target.externalId },
      }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    expect(executed).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses pane.close for an id no pane has, and every other command', async () => {
    const conn = await client(
      createScriptToken(storeFile, 'c', ['all-workspaces', 'kill-pane']).token,
    )
    await expect(
      conn.sendRequest('command.exec', { id: 'pane.close', args: { paneId: 'no-such-pane' } }),
    ).rejects.toThrow('unknown-pane: no-such-pane')
    await expect(conn.sendRequest('command.exec', { id: 'pane.close' })).rejects.toThrow(
      'needs {"paneId"',
    )
    await expect(conn.sendRequest('command.exec', { id: 'tab.new' })).rejects.toThrow(
      'not-available-to-script',
    )
    expect(executed).toEqual([])
  })

  it.each([
    ['workspace.group', { name: 'AurigaX' }],
    ['workspace.ungroup', undefined],
    ['workspace.describe', { text: 'tracker#24' }],
  ])('runs %s on the workspace it names, with all-workspaces', async (id, args) => {
    const conn = await client(createScriptToken(storeFile, 'ceo', ['all-workspaces']).token)
    await expect(conn.sendRequest('command.exec', { id, args, target: WS2 })).resolves.toEqual({
      ok: true,
      result: { workspaceId: 'ws-new' },
    })
    expect(executed).toEqual([{ target: inWs2, id, args }])
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    ['workspace.groupColor', { group: 'AurigaX', color: 'blue' }],
    ['workspace.newScratch', undefined],
  ])('runs %s, which needs no workspace, in the primary window', async (id, args) => {
    const conn = await client(createScriptToken(storeFile, 'ceo', ['all-workspaces']).token)
    await conn.sendRequest('command.exec', { id, args })
    expect(executed).toEqual([
      { target: { windowId: 'w1', workspaceId: '', paneId: null }, id, args },
    ])
  })

  it.each<[string, Capability]>([
    ['workspace.hibernateAgents', 'kill-pane'],
    ['workspace.hibernateGroupAgents', 'kill-pane'],
    ['workspace.resumeAgents', 'type-other-pane'],
    ['workspace.resumeGroupAgents', 'type-other-pane'],
  ])('runs %s on a named workspace only with %s and all-workspaces', async (id, cap) => {
    const without = await client(createScriptToken(storeFile, 'a', ['all-workspaces']).token)
    await expect(without.sendRequest('command.exec', { id, target: WS2 })).rejects.toThrow(
      `needs-elevation: ${cap}`,
    )
    const noReach = await client(createScriptToken(storeFile, 'b', [cap]).token)
    await expect(noReach.sendRequest('command.exec', { id, target: WS2 })).rejects.toThrow(
      'needs-elevation: all-workspaces',
    )
    expect(executed).toEqual([])
    const full = await client(createScriptToken(storeFile, 'c', ['all-workspaces', cap]).token)
    await full.sendRequest('command.exec', { id, target: WS2 })
    expect(executed).toEqual([{ target: inWs2, id }])
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    'workspace.group',
    'workspace.ungroup',
    'workspace.describe',
    'workspace.hibernateAgents',
    'workspace.hibernateGroupAgents',
    'workspace.resumeAgents',
    'workspace.resumeGroupAgents',
  ])('refuses %s without a workspace instead of picking one', async (id) => {
    const conn = await client(
      createScriptToken(storeFile, 'c', ['all-workspaces', 'kill-pane', 'type-other-pane']).token,
    )
    await expect(conn.sendRequest('command.exec', { id, args: { name: 'x' } })).rejects.toThrow(
      `bad-request: ${id} from a script token needs a workspace`,
    )
    expect(executed).toEqual([])
  })

  it('closes the workspace it names only with kill-pane and all-workspaces', async () => {
    const id = 'workspace.close'
    const noKill = await client(createScriptToken(storeFile, 'a', ['all-workspaces']).token)
    await expect(noKill.sendRequest('command.exec', { id, target: WS2 })).rejects.toThrow(
      'needs-elevation: kill-pane',
    )
    const noReach = await client(createScriptToken(storeFile, 'b', ['kill-pane']).token)
    await expect(noReach.sendRequest('command.exec', { id, target: WS2 })).rejects.toThrow(
      'needs-elevation: all-workspaces',
    )
    const full = await client(
      createScriptToken(storeFile, 'c', ['all-workspaces', 'kill-pane']).token,
    )
    await expect(full.sendRequest('command.exec', { id })).rejects.toThrow(
      'bad-request: workspace.close from a script token needs a workspace',
    )
    expect(executed).toEqual([])
    await full.sendRequest('command.exec', { id, target: WS2 })
    expect(executed).toEqual([{ target: inWs2, id }])
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses a workspace command without all-workspaces', async () => {
    const conn = await client(createScriptToken(storeFile, 'k', ['kill-pane']).token)
    await expect(
      conn.sendRequest('command.exec', { id: 'workspace.group', args: { name: 'x' }, target: WS2 }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    expect(executed).toEqual([])
  })

  it.each([
    'settings.set',
    'workspace.deleteGroup',
    'workspace.goto',
    'workspace.closeOthers',
    'tab.new',
  ])('still refuses %s to a token holding every script capability', async (id) => {
    const conn = await client(createScriptToken(storeFile, 'all', [...SCRIPT_CAPABILITIES]).token)
    await expect(conn.sendRequest('command.exec', { id, target: WS2 })).rejects.toThrow(
      'not-available-to-script',
    )
    expect(executed).toEqual([])
  })

  it('lists only the commands open to scripts, from the primary window', async () => {
    const conn = await client(createScriptToken(storeFile, 'l', ['read-board']).token)
    const list = await conn.sendRequest<{ id: string }[]>('command.list')
    expect(list.map((d) => d.id).sort()).toEqual([...SCRIPT_COMMANDS].sort())
  })

  it('reads the terminal state of a named pane, never its own or the manager', async () => {
    const pane = registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'inner-info' })
    registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'inner-info-mgr' })
    const manager = markManager('inner-info-mgr')
    const conn = await client(createScriptToken(storeFile, 'i', ['read-board']).token)
    await expect(conn.sendRequest('pane.info', { paneId: pane.externalId })).resolves.toMatchObject(
      {
        cwd: '/w',
        running: true,
      },
    )
    await expect(conn.sendRequest('pane.info', {})).rejects.toThrow('bad-request: paneId')
    await expect(conn.sendRequest('pane.info', { paneId: manager?.externalId })).resolves.toBeNull()
    const blind = await client(createScriptToken(storeFile, 'j', ['process']).token)
    await expect(blind.sendRequest('pane.info', { paneId: pane.externalId })).rejects.toThrow(
      'needs-elevation: read-board',
    )
  })
})
