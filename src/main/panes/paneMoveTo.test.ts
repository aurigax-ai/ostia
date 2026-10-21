import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'
import type { CommandResult } from '../../shared/control/commands'
import type { ApprovalOutcome } from '../../shared/permissions/approvals'
import type { ApprovalAsk } from '../approvals/approvals'
import type { ReachCaller } from '../approvals/reach'

let answer: ApprovalOutcome = 'deny'
const asked: ApprovalAsk[] = []
const request = vi.fn(async (ask: ApprovalAsk) => {
  asked.push(ask)
  return answer
})

vi.mock('../approvals/approvals', () => ({ approvals: () => ({ request }) }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { setCapFilter, setScriptTokenCheck } = await import('../control/controlAuth')
const { ensureCaps } = await import('../approvals/controlElevation')
const { registerControlServer, stopControlServer } = await import('../control/controlServer')
const { getByPaneId, markManager, registerPane } = await import('../control/idRegistry')
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
const tabMembers = new Map<string, string[]>()
const lockedPanes = new Set<string>()
const joins: { workspaceId: string; paneIds: string[]; tab: string | null }[] = []
const vanished = new Set<string>()
const straySplitTab = new Map<string, string>()
const wholeWorkspaces = new Set<string>()

const inScope = async (ctx: ReachCaller, workspaceId: string) =>
  ctx.identity.workspaceId === workspaceId || scoped.has(workspaceId)

registerPaneMoveToMethods({
  processPane: async (ref) => (ref === 'worker' ? ['child-pane'] : []),
  visible: async () => () => true,
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
  tabPlan: async (workspaceId, paneIds, tab) => ({
    ok: true,
    result: {
      members: tab ? (tabMembers.get(`${workspaceId}/${tab}`) ?? []) : [],
      locked: paneIds.filter((id) => lockedPanes.has(id)),
    },
  }),
  joinTab: async (workspaceId, paneIds, tab) => {
    joins.push({ workspaceId, paneIds, tab })
    const members = tab ? (tabMembers.get(`${workspaceId}/${tab}`) ?? []) : []
    return {
      ok: true,
      result: {
        moved: paneIds.filter((id) => !members.includes(id)),
        whole: wholeWorkspaces.has(workspaceId),
      },
    }
  },
  panes: async () =>
    ['agent-pane', 'child-pane', 'sibling-pane'].flatMap((paneId) => {
      if (vanished.has(paneId)) return []
      const identity = getByPaneId(paneId)
      const workspaceId = moved.filter((m) => m.paneId === paneId).at(-1)?.workspaceId ?? 'ws1'
      const join = joins.filter((j) => j.paneIds.includes(paneId)).at(-1)
      const splitTabName = wholeWorkspaces.has(workspaceId)
        ? undefined
        : (straySplitTab.get(paneId) ?? join?.tab ?? undefined)
      return [
        {
          paneId: identity?.externalId ?? paneId,
          workspaceId,
          kind: 'terminal',
          title: paneId,
          running: true,
          blockCount: 0,
          ...(splitTabName ? { splitTabName } : {}),
        },
      ]
    }),
})

const agent = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'agent-pane' })
const child = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'child-pane' })
const sibling = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'sibling-pane' })
const managerPane = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'mgr-pane' })
markManager('mgr-pane')

const SCRIPT_TOKENS: Record<string, Capability[]> = {
  'ostia_move-full': ['type-other-pane', 'all-workspaces'],
  'ostia_move-no-type': ['all-workspaces'],
  'ostia_move-no-reach': ['type-other-pane'],
}
setScriptTokenCheck((token) => {
  const caps = SCRIPT_TOKENS[token]
  return caps ? { id: `script_${token}`, caps } : undefined
})

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
  tabMembers.clear()
  lockedPanes.clear()
  joins.length = 0
  vanished.clear()
  straySplitTab.clear()
  wholeWorkspaces.clear()
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
    await expect(move(conn, ['worker'], 'ws2')).resolves.toMatchObject({
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
      'bad-request: workspace or tab',
    )
    expect(moved).toEqual([])
  })

  it('leaves a pane that is already there alone', async () => {
    const conn = await client(agent)
    await expect(move(conn, ['worker'], 'ws1')).resolves.toMatchObject({
      ok: true,
      moved: [],
      workspaceId: 'ws1',
    })
    expect(moved).toEqual([])
  })
})

const moveToTab = (conn: MessageConnection, panes: string[], tab: string, workspace?: string) =>
  conn.sendRequest('pane.moveTo', { panes, tab, ...(workspace ? { workspace } : {}) })

describe('pane.moveTo with a tab', () => {
  it('joins a tab the caller opened into a split tab of its workspace without asking', async () => {
    const conn = await client(agent)
    await expect(moveToTab(conn, ['worker'], 'workers')).resolves.toMatchObject({
      ok: true,
      moved: [child.externalId],
    })
    expect(joins).toEqual([{ workspaceId: 'ws1', paneIds: ['child-pane'], tab: 'workers' }])
    expect(moved).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })

  it('reports nothing for a pane already in the tab', async () => {
    tabMembers.set('ws1/workers', ['child-pane'])
    const conn = await client(agent)
    await expect(moveToTab(conn, ['worker'], 'workers')).resolves.toMatchObject({
      ok: true,
      moved: [],
    })
  })

  it('puts panes back into their own tabs with new', async () => {
    const conn = await client(agent)
    await moveToTab(conn, ['worker'], 'new')
    expect(joins).toEqual([{ workspaceId: 'ws1', paneIds: ['child-pane'], tab: null }])
  })

  it('joins a tab only when the caller reaches every pane in it', async () => {
    tabMembers.set('ws1/workers', ['sibling-pane'])
    const conn = await client(agent)
    await expect(moveToTab(conn, ['worker'], 'workers')).rejects.toThrow('denied: type-other-pane')
    expect(asked[0]).toMatchObject({ action: 'pane.moveTo' })
    expect(joins).toEqual([])
  })

  it('refuses a locked pane before moving anything', async () => {
    scoped.add('ws2')
    lockedPanes.add('child-pane')
    const conn = await client(agent)
    await expect(moveToTab(conn, ['worker'], 'workers', 'ws2')).rejects.toThrow('pane-locked')
    expect(moved).toEqual([])
    expect(joins).toEqual([])
  })

  it('moves into another workspace first and joins the tab there', async () => {
    scoped.add('ws2')
    const conn = await client(agent)
    await expect(moveToTab(conn, ['worker'], 'workers', 'ws2')).resolves.toMatchObject({
      ok: true,
      moved: [child.externalId],
      workspaceId: 'ws2',
    })
    expect(moved).toEqual([{ paneId: 'child-pane', workspaceId: 'ws2' }])
    expect(joins).toEqual([{ workspaceId: 'ws2', paneIds: ['child-pane'], tab: 'workers' }])
  })

  it('refuses the manager pane, scratch and sandboxed workspaces and a bad name', async () => {
    answer = 'once'
    for (const ws of ['ws-scratch', 'ws-sbx']) scoped.add(ws)
    const conn = await client(agent)
    await expect(moveToTab(conn, [managerPane.externalId], 'workers')).rejects.toThrow(
      'unknown-pane',
    )
    await expect(moveToTab(conn, ['worker'], 'workers', 'ws-scratch')).rejects.toThrow('scratch:')
    await expect(moveToTab(conn, ['worker'], 'workers', 'ws-sbx')).rejects.toThrow('sandboxed:')
    await expect(moveToTab(conn, ['worker'], ' ')).rejects.toThrow('bad-request: tab')
    expect(moved).toEqual([])
    expect(joins).toEqual([])
  })
})

describe('pane.moveTo reads the placement back', () => {
  it('answers with the placement the layout reports', async () => {
    scoped.add('ws2')
    const conn = await client(agent)
    const res = await moveToTab(conn, ['worker'], 'workers', 'ws2')
    expect(res).toMatchObject({
      placement: [{ paneId: child.externalId, workspaceId: 'ws2', splitTabName: 'workers' }],
    })
  })

  it('accepts panes that became the whole layout of their workspace, and nothing else untabbed', async () => {
    const conn = await client(agent)
    straySplitTab.set('agent-pane', '')
    straySplitTab.set('child-pane', '')
    await expect(moveToTab(conn, [agent.externalId, 'worker'], 'workers')).rejects.toThrow(
      `misplaced: ${agent.externalId} is in no split tab, not workers`,
    )
    straySplitTab.clear()

    wholeWorkspaces.add('ws2')
    scoped.add('ws2')
    const res = await moveToTab(conn, [agent.externalId, 'worker'], 'workers', 'ws2')
    expect(res).toMatchObject({
      placement: [
        { paneId: agent.externalId, workspaceId: 'ws2' },
        { paneId: child.externalId, workspaceId: 'ws2' },
      ],
    })
  })

  it('fails with the reason when the pane did not land where it was sent', async () => {
    straySplitTab.set('child-pane', 'other')
    const conn = await client(agent)
    await expect(moveToTab(conn, ['worker'], 'workers')).rejects.toThrow(
      `misplaced: ${child.externalId} is in split tab other, not workers`,
    )
    straySplitTab.clear()
    vanished.add('child-pane')
    await expect(moveToTab(conn, ['worker'], 'new')).rejects.toThrow(
      `misplaced: ${child.externalId} is gone`,
    )
  })
})

describe('pane.moveTo from a script token', () => {
  it('moves a pane into another workspace with type-other-pane and all-workspaces', async () => {
    const conn = await client({ token: 'ostia_move-full' })
    await expect(move(conn, [sibling.externalId], 'ws2')).resolves.toMatchObject({
      ok: true,
      moved: [sibling.externalId],
      workspaceId: 'ws2',
    })
    expect(moved).toEqual([{ paneId: 'sibling-pane', workspaceId: 'ws2' }])
    expect(request).not.toHaveBeenCalled()
  })

  it('needs both capabilities, names its panes and workspace, and never moves the manager', async () => {
    const noType = await client({ token: 'ostia_move-no-type' })
    await expect(move(noType, [sibling.externalId], 'ws2')).rejects.toThrow(
      'needs-elevation: type-other-pane',
    )
    const noReach = await client({ token: 'ostia_move-no-reach' })
    await expect(move(noReach, [sibling.externalId], 'ws2')).rejects.toThrow(
      'needs-elevation: all-workspaces',
    )
    const full = await client({ token: 'ostia_move-full' })
    await expect(full.sendRequest('pane.moveTo', { panes: [sibling.externalId] })).rejects.toThrow(
      'bad-request: workspace or tab',
    )
    await expect(full.sendRequest('pane.moveTo', { workspace: 'ws2' })).rejects.toThrow(
      'bad-request: panes',
    )
    await expect(move(full, [managerPane.externalId], 'ws2')).rejects.toThrow('unknown-pane')
    expect(moved).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })
})
