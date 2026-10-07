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
import type { ApprovalOutcome } from '../shared/approvals'
import type { CommandResult } from '../shared/types'
import type { ApprovalAsk } from './approvals'
import type { ReachCaller } from './reach'

let answer: ApprovalOutcome = 'deny'
const asked: ApprovalAsk[] = []
const request = vi.fn(async (ask: ApprovalAsk) => {
  asked.push(ask)
  return answer
})

vi.mock('./approvals', () => ({ approvals: () => ({ request }) }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { setCapFilter } = await import('./controlAuth')
const { ensureCaps } = await import('./controlElevation')
const { registerControlServer, stopControlServer } = await import('./controlServer')
const { markManager, registerPane } = await import('./idRegistry')
const { registerPaneMoveToMethods } = await import('./paneMoveTo')

const owners: Record<string, string> = {
  ws1: 'w1',
  ws2: 'w1',
  ws3: 'w1',
  'ws-other': 'w2',
  'ws-scratch': 'w1',
  'ws-sbx': 'w1',
}
const scoped = new Set<string>()
const children = new Map<string, string>()
const moved: { paneId: string; workspaceId: string }[] = []
const reachAsked: string[] = []

const inScope = async (ctx: ReachCaller, workspaceId: string) =>
  ctx.identity.workspaceId === workspaceId || scoped.has(workspaceId)

registerPaneMoveToMethods({
  processPane: async (ref) => (ref === 'worker' ? 'child-pane' : undefined),
  inScope,
  isChild: (ownerPaneId, paneId) => children.get(paneId) === ownerPaneId,
  isSandboxed: (workspaceId) => workspaceId === 'ws-sbx',
  isConfined: () => false,
  ownerWindow: (workspaceId) => owners[workspaceId],
  paneOf: (paneId) => {
    const panes: Record<string, { windowId: string; workspaceId: string; manager?: true }> = {
      'agent-pane': { windowId: 'w1', workspaceId: 'ws1' },
      'child-pane': { windowId: 'w1', workspaceId: 'ws1' },
      'sibling-pane': { windowId: 'w1', workspaceId: 'ws1' },
      'mgr-pane': { windowId: 'w1', workspaceId: 'ws1', manager: true },
    }
    return panes[paneId]
  },
  isScratch: (workspaceId) => workspaceId === 'ws-scratch',
  ensureReach: async (ctx, workspaceId, action, detail) => {
    reachAsked.push(workspaceId)
    if (await inScope(ctx, workspaceId)) return
    await ensureCaps(ctx.authed, ctx.identity, ['all-workspaces'], action, detail)
  },
  move: async (pane, workspaceId) => {
    moved.push({ paneId: pane.paneId, workspaceId })
    return { ok: true, result: { moved: [pane.paneId] } } as CommandResult
  },
})

const agent = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'agent-pane' })
const child = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'child-pane' })
const sibling = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'sibling-pane' })
const managerPane = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'mgr-pane' })
markManager('mgr-pane')

let socketPath = ''
let seq = 0
const clients: MessageConnection[] = []

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
  socketPath = join(tmpdir(), `ostia-pane-move-${process.pid}-${seq}.sock`)
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
  asked.length = 0
  request.mockClear()
  scoped.clear()
  children.clear()
  children.set('child-pane', 'agent-pane')
  moved.length = 0
  reachAsked.length = 0
  setCapFilter(() => true)
})

afterEach(() => {
  for (const c of clients.splice(0)) c.dispose()
  stopControlServer()
})

const move = (conn: MessageConnection, panes: string[], workspace: string) =>
  conn.sendRequest('pane.moveTo', { panes, workspace })

describe('pane.moveTo', () => {
  it('moves a tab the caller opened into a workspace within its reach without asking', async () => {
    scoped.add('ws2')
    const conn = await client(agent)
    await expect(move(conn, ['worker'], 'ws2')).resolves.toEqual({
      ok: true,
      moved: [child.externalId],
      workspaceId: 'ws2',
    })
    expect(moved).toEqual([{ paneId: 'child-pane', workspaceId: 'ws2' }])
    expect(reachAsked).toEqual(['ws2'])
    expect(request).not.toHaveBeenCalled()
  })

  it('lets the caller move its own pane', async () => {
    scoped.add('ws2')
    const conn = await client(agent)
    await move(conn, [agent.externalId], 'ws2')
    expect(moved).toEqual([{ paneId: 'agent-pane', workspaceId: 'ws2' }])
    expect(request).not.toHaveBeenCalled()
  })

  it('asks for all-workspaces outside its reach and moves nothing on Deny', async () => {
    const conn = await client(agent)
    await expect(move(conn, ['worker'], 'ws3')).rejects.toThrow('denied: all-workspaces')
    expect(asked[0]).toMatchObject({ caps: ['all-workspaces'], action: 'pane.moveTo' })
    expect(moved).toEqual([])
  })

  it('asks for type-other-pane for a pane the caller did not open', async () => {
    scoped.add('ws2')
    const conn = await client(agent)
    await expect(move(conn, [sibling.externalId], 'ws2')).rejects.toThrow('denied: type-other-pane')
    expect(moved).toEqual([])
    answer = 'once'
    await move(conn, [sibling.externalId], 'ws2')
    expect(moved).toEqual([{ paneId: 'sibling-pane', workspaceId: 'ws2' }])
  })

  it('checks every named pane before moving any', async () => {
    scoped.add('ws2')
    const conn = await client(agent)
    await expect(move(conn, ['worker', sibling.externalId], 'ws2')).rejects.toThrow(
      'denied: type-other-pane',
    )
    expect(moved).toEqual([])
  })

  it('never moves the manager pane', async () => {
    answer = 'once'
    scoped.add('ws2')
    const conn = await client(agent)
    await expect(move(conn, [managerPane.externalId], 'ws2')).rejects.toThrow('unknown-pane')
    expect(moved).toEqual([])
  })

  it('refuses scratch and sandboxed workspaces, another window and an unknown workspace', async () => {
    answer = 'once'
    for (const ws of ['ws-scratch', 'ws-sbx', 'ws-other']) scoped.add(ws)
    const conn = await client(agent)
    await expect(move(conn, ['worker'], 'ws-scratch')).rejects.toThrow('scratch:')
    await expect(move(conn, ['worker'], 'ws-sbx')).rejects.toThrow('sandboxed:')
    await expect(move(conn, ['worker'], 'ws-other')).rejects.toThrow('other-window:')
    await expect(move(conn, ['worker'], 'nope')).rejects.toThrow('unknown-workspace: nope')
    await expect(conn.sendRequest('pane.moveTo', { panes: ['worker'] })).rejects.toThrow(
      'bad-request: workspace',
    )
    expect(moved).toEqual([])
  })

  it('leaves a pane that is already there alone', async () => {
    const conn = await client(agent)
    await expect(move(conn, ['worker'], 'ws1')).resolves.toEqual({
      ok: true,
      moved: [],
      workspaceId: 'ws1',
    })
    expect(moved).toEqual([])
  })
})
