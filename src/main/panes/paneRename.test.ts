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
import { SCRIPT_CAPABILITIES } from '../../shared/permissions/scriptTokens'
import type { CommandResult, CommandTarget } from '../../shared/types'

const request = vi.fn(async () => 'deny' as const)

vi.mock('../approvals/approvals', () => ({ approvals: () => ({ request }) }))

const { grant } = await import('../approvals/capabilityStore')
const { setCapFilter, setScriptTokenCheck } = await import('../control/controlAuth')
const { registerControlServer, stopControlServer } = await import('../control/controlServer')
const { markManager, registerPane } = await import('../control/idRegistry')
const { cleanName, registerPaneRenameMethods, renameCaps } = await import('./paneRename')

const calls: { target: CommandTarget; id: string; args: unknown }[] = []
let reply: CommandResult = { ok: true, result: undefined }

registerPaneRenameMethods({
  execCommand: async (target, id, args) => {
    calls.push({ target, id, args })
    return reply
  },
  reach: { inScope: async (ctx, workspaceId) => ctx.identity.workspaceId === workspaceId },
})

const sibling = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'rename-sibling' })
const foreign = registerPane({ windowId: 'w2', workspaceId: 'ws2', paneId: 'rename-foreign' })
const manager = registerPane({ windowId: 'w1', workspaceId: 'ws-mgr', paneId: 'rename-mgr' })
markManager('rename-mgr')

const SCRIPT_TOKEN = 'ostia_rename-script'
const GRANTED = 'ostia_rename-granted'
const BARE = 'ostia_rename-bare'
const NO_REACH = 'ostia_rename-no-reach'
setScriptTokenCheck((token) => {
  if (token === GRANTED) {
    return { id: 'script_rename_granted', caps: ['send-other-pane', 'all-workspaces'] }
  }
  if (token === BARE) return { id: 'script_rename_bare', caps: ['all-workspaces'] }
  if (token === NO_REACH) return { id: 'script_rename_no_reach', caps: ['send-other-pane'] }
  return token === SCRIPT_TOKEN
    ? { id: 'script_rename', caps: [...SCRIPT_CAPABILITIES] }
    : undefined
})

let socketPath = ''
let seq = 0
const clients: MessageConnection[] = []

function freshPane(workspaceId: string): ReturnType<typeof registerPane> {
  return registerPane({ windowId: 'w1', workspaceId, paneId: `rename-caller-${++seq}` })
}

async function client(identity: { token: string }): Promise<MessageConnection> {
  const socket = createConnection(socketPath)
  const conn = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  conn.listen()
  clients.push(conn)
  await conn.sendRequest('hello', { token: identity.token })
  return conn
}

beforeEach(() => {
  seq += 1
  socketPath = join(tmpdir(), `ostia-rename-${process.pid}-${seq}.sock`)
  registerControlServer(
    {
      execCommand: async () => ({ ok: true }) as CommandResult,
      listCommandsFor: () => [],
      getTerminalState: () => undefined,
      isSandboxed: () => false,
    },
    socketPath,
  )
  calls.length = 0
  reply = { ok: true, result: undefined }
  request.mockClear()
  setCapFilter(() => true)
})

afterEach(() => {
  for (const c of clients.splice(0)) c.dispose()
  stopControlServer()
})

describe('cleanName', () => {
  it('trims, keeps an empty name to clear, and refuses control characters and long names', () => {
    expect(cleanName('  W9 控制面補齊  ', 'title')).toBe('W9 控制面補齊')
    expect(cleanName('', 'title')).toBe('')
    expect(() => cleanName(undefined, 'title')).toThrow('bad-request: title')
    expect(() => cleanName('a\nb', 'title')).toThrow('control characters')
    expect(() => cleanName('\x1b]0;x\x07', 'title')).toThrow('control characters')
    expect(() => cleanName('x'.repeat(201), 'title')).toThrow('too-long: title')
  })
})

describe('renameCaps', () => {
  it('needs drive-self for yourself, send-other-pane for others, all-workspaces across', () => {
    expect(renameCaps(true, true)).toEqual(['drive-self'])
    expect(renameCaps(false, true)).toEqual(['send-other-pane'])
    expect(renameCaps(false, false)).toEqual(['send-other-pane', 'all-workspaces'])
  })
})

describe('pane.rename', () => {
  it('renames the caller pane when no pane is given', async () => {
    const me = freshPane('ws1')
    const conn = await client(me)

    const res = await conn.sendRequest('pane.rename', { title: 'W9 控制面補齊' })

    expect(res).toEqual({ ok: true, paneId: me.externalId, title: 'W9 控制面補齊' })
    expect(calls).toEqual([
      {
        target: { windowId: 'w1', workspaceId: 'ws1', paneId: me.paneId },
        id: 'pane.rename',
        args: { title: 'W9 控制面補齊' },
      },
    ])
    expect(request).not.toHaveBeenCalled()
  })

  it('asks the human before renaming another pane and does nothing when denied', async () => {
    const conn = await client(freshPane('ws1'))

    await expect(
      conn.sendRequest('pane.rename', { pane: sibling.externalId, title: 'x' }),
    ).rejects.toThrow('denied: send-other-pane')
    expect(calls).toEqual([])
  })

  it('renames another pane with send-other-pane, plus all-workspaces across', async () => {
    const me = freshPane('ws1')
    grant(me.externalId, 'send-other-pane')
    const conn = await client(me)

    await conn.sendRequest('pane.rename', { pane: sibling.externalId, title: 'worker' })
    expect(calls[0]).toMatchObject({
      target: { paneId: 'rename-sibling' },
      args: { title: 'worker' },
    })

    await expect(
      conn.sendRequest('pane.rename', { pane: foreign.externalId, title: 'worker' }),
    ).rejects.toThrow('denied: all-workspaces')
    grant(me.externalId, 'all-workspaces')
    await conn.sendRequest('pane.rename', { pane: foreign.externalId, title: 'worker' })
    expect(calls[1]).toMatchObject({ target: { windowId: 'w2', paneId: 'rename-foreign' } })
  })

  it('hides the manager pane and unknown panes', async () => {
    const me = freshPane('ws1')
    grant(me.externalId, 'send-other-pane')
    grant(me.externalId, 'all-workspaces')
    const conn = await client(me)

    await expect(
      conn.sendRequest('pane.rename', { pane: manager.externalId, title: 'x' }),
    ).rejects.toThrow('unknown-pane')
    await expect(conn.sendRequest('pane.rename', { pane: 'nope', title: 'x' })).rejects.toThrow(
      'unknown-pane: nope',
    )
    expect(calls).toEqual([])
  })

  it('passes an empty title through so the program owns the tab again', async () => {
    const conn = await client(freshPane('ws1'))
    await conn.sendRequest('pane.rename', { title: '' })
    expect(calls[0]?.args).toEqual({ title: '' })
  })

  it('reports a renderer failure', async () => {
    reply = { ok: false, error: { code: 'command-failed', message: 'no target pane' } }
    const conn = await client(freshPane('ws1'))
    await expect(conn.sendRequest('pane.rename', { title: 'x' })).rejects.toThrow(
      'command-failed: no target pane',
    )
  })
})

describe('workspace.rename', () => {
  it("renames the caller's workspace in the window that shows it", async () => {
    const conn = await client(freshPane('ws1'))

    const res = await conn.sendRequest('workspace.rename', { name: 'research' })

    expect(res).toEqual({ ok: true, workspaceId: 'ws1', name: 'research' })
    expect(calls).toEqual([
      {
        target: { windowId: 'w1', workspaceId: 'ws1', paneId: null },
        id: 'workspace.rename',
        args: { name: 'research' },
      },
    ])
  })

  it('asks before renaming another workspace and refuses an unknown one', async () => {
    const me = freshPane('ws1')
    const conn = await client(me)

    await expect(
      conn.sendRequest('workspace.rename', { workspace: 'ws2', name: 'x' }),
    ).rejects.toThrow('denied: send-other-pane, all-workspaces')
    grant(me.externalId, 'send-other-pane')
    grant(me.externalId, 'all-workspaces')
    await conn.sendRequest('workspace.rename', { workspace: 'ws2', name: 'x' })
    expect(calls[0]?.target).toEqual({ windowId: 'w2', workspaceId: 'ws2', paneId: null })
    await expect(
      conn.sendRequest('workspace.rename', { workspace: 'ws-none', name: 'x' }),
    ).rejects.toThrow('unknown-workspace: ws-none')
  })
})

describe('rename from a script token', () => {
  it('renames a pane when the token holds send-other-pane and all-workspaces', async () => {
    const conn = await client({ token: GRANTED })

    const res = await conn.sendRequest('pane.rename', { pane: foreign.externalId, title: 'line' })

    expect(res).toEqual({ ok: true, paneId: foreign.externalId, title: 'line' })
    expect(calls[0]).toMatchObject({
      target: { windowId: 'w2', paneId: 'rename-foreign' },
      id: 'pane.rename',
      args: { title: 'line' },
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('is refused without the grant, and never asks the human', async () => {
    const conn = await client({ token: BARE })

    await expect(
      conn.sendRequest('pane.rename', { pane: sibling.externalId, title: 'x' }),
    ).rejects.toThrow('needs-elevation: send-other-pane')
    expect(calls).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })

  it('needs all-workspaces for any pane, since a script has no workspace of its own', async () => {
    const conn = await client({ token: NO_REACH })

    await expect(
      conn.sendRequest('pane.rename', { pane: sibling.externalId, title: 'x' }),
    ).rejects.toThrow('needs-elevation: all-workspaces')
    expect(calls).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })

  it('has no pane of its own, so it must name one, and cannot reach the manager pane', async () => {
    const conn = await client({ token: GRANTED })

    await expect(conn.sendRequest('pane.rename', { title: 'x' })).rejects.toThrow(
      'bad-request: pane',
    )
    await expect(
      conn.sendRequest('pane.rename', { pane: manager.externalId, title: 'x' }),
    ).rejects.toThrow('unknown-pane')
    expect(calls).toEqual([])
  })

  it('still cannot rename a workspace', async () => {
    const conn = await client({ token: GRANTED })

    await expect(
      conn.sendRequest('workspace.rename', { workspace: 'ws1', name: 'x' }),
    ).rejects.toThrow('not-available-to-script')
    expect(calls).toEqual([])
  })
})
