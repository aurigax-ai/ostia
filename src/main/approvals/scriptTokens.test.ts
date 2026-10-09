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
import { DEFAULT_CAPABILITIES } from '../../shared/capabilities'
import type { ApprovalOutcome } from '../../shared/permissions/approvals'
import type { CommandResult } from '../../shared/types'

let answer: ApprovalOutcome = 'deny'
const request = vi.fn(async () => answer)

vi.mock('./approvals', () => ({ approvals: () => ({ request }) }))

const { setCapFilter, setScriptTokenCheck } = await import('../control/controlAuth')
const { registerControlMethod, registerControlServer, stopControlServer } = await import(
  '../control/controlServer'
)
const { registerPane } = await import('../control/idRegistry')
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

  it('lets a token hold process, send-other-pane and kill-pane, but never shell', () => {
    expect(
      parseTokenRequest({
        name: 'cron',
        caps: ['process', 'send-other-pane', 'all-workspaces', 'kill-pane'],
      }),
    ).toEqual({ name: 'cron', caps: ['all-workspaces', 'process', 'send-other-pane', 'kill-pane'] })
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
    await expect(conn.sendRequest('command.list')).rejects.toThrow('not-available-to-script')
    expect(request).not.toHaveBeenCalled()
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
  const descriptor = (id: string, capabilities: string[]) => ({
    id,
    title: id,
    category: null,
    hidden: false,
    argsSchema: null,
    resultSchema: null,
    capabilities,
    target: 'active',
  })
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
        listCommandsFor: (windowId) =>
          windowId === 'w1'
            ? ([
                descriptor('workspace.new', DEFAULT_CAPABILITIES),
                descriptor('pane.close', ['kill-pane']),
                descriptor('tab.new', []),
              ] as never)
            : [],
        getTerminalState: () => undefined,
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
})
