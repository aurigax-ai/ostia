import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import {
  DEFAULT_MANAGER_SETTINGS,
  type ManagerSettings,
  managerAgents,
} from '../shared/managerSettings'
import type { CommandResult } from '../shared/types'
import { registerControlServer, stopControlServer } from './controlServer'
import { registerDocsMethods } from './docs'
import { markManager, registerPane } from './idRegistry'
import { type ManagerMethodDeps, registerManagerMethods } from './managerMethods'
import { RateWindow } from './rateWindow'

let settings: ManagerSettings = DEFAULT_MANAGER_SETTINGS
const written: { paneId: string; data: string }[] = []
const opened: { argv: string[]; cwd?: string; workspaceId?: string; name?: string }[] = []
const dead = new Set<string>()
let now = 0
let workerSeq = 0

const deps: ManagerMethodDeps = {
  settings: () => settings,
  agents: () => managerAgents(settings),
  io: {
    read: async (paneId, lines) => (paneId === 'no-pty' ? null : `screen of ${paneId} (${lines})`),
    write: (paneId, data) => {
      written.push({ paneId, data })
      return true
    },
    bracketedPaste: () => false,
    outputCursor: () => undefined,
  },
  openWorker: async (req) => {
    opened.push(req)
    workerSeq += 1
    return registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: `worker-${workerSeq}` })
      .externalId
  },
  paneAlive: (paneId) => !dead.has(paneId),
  now: () => now,
}

const limiter = registerManagerMethods(deps)
registerDocsMethods({ extensions: () => [] })

const managerPane = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'mgr-pane' })
markManager('mgr-pane')
const workerPane = registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'plain-pane' })
const noPtyPane = registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'no-pty' })

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
  socketPath = join(tmpdir(), `ostia-mgr-methods-${process.pid}-${seq}.sock`)
  registerControlServer(
    {
      execCommand: async () => ({ ok: true }) as CommandResult,
      listCommandsFor: () => [],
      getTerminalState: () => undefined,
      isSandboxed: () => false,
    },
    socketPath,
  )
  settings = DEFAULT_MANAGER_SETTINGS
  written.length = 0
  opened.length = 0
  dead.clear()
  now = seq * 1_000_000_000
})

afterEach(() => {
  for (const c of clients.splice(0)) c.dispose()
  stopControlServer()
})

describe('manager methods', () => {
  it('MGR-C31 are refused to an ordinary pane without naming the manager', async () => {
    const worker = await client(workerPane.token)
    for (const method of ['manager.read', 'manager.spawn', 'manager.input']) {
      await expect(worker.sendRequest(method, {})).rejects.toThrow('not-available-to-pane')
    }
  })

  it('MGR-C31 read another pane as plain text, capped, and never the manager pane', async () => {
    const mgr = await client(managerPane.token)
    await expect(
      mgr.sendRequest('manager.read', { paneId: workerPane.externalId, lines: 99999 }),
    ).resolves.toEqual({ paneId: workerPane.externalId, text: 'screen of plain-pane (2000)' })
    await expect(
      mgr.sendRequest('manager.read', { paneId: managerPane.externalId }),
    ).rejects.toThrow('own-pane')
    await expect(mgr.sendRequest('manager.read', { paneId: 'nope' })).rejects.toThrow(
      'unknown-pane',
    )
    await expect(mgr.sendRequest('manager.read', { paneId: noPtyPane.externalId })).rejects.toThrow(
      'no-terminal',
    )
  })

  it('MGR-C29 spawns a preset worker with args, and stops at the live-worker limit', async () => {
    settings = {
      ...DEFAULT_MANAGER_SETTINGS,
      limits: { ...DEFAULT_MANAGER_SETTINGS.limits, maxWorkers: 1 },
    }
    const mgr = await client(managerPane.token)
    const first = await mgr.sendRequest<{ paneId: string }>('manager.spawn', {
      agent: 'claude',
      args: ['-p', 'fix the bug'],
      cwd: '/home/u/proj',
      name: 'bugfix',
    })
    expect(opened[0]).toEqual({
      argv: ['claude', '-p', 'fix the bug'],
      cwd: '/home/u/proj',
      name: 'bugfix',
    })
    await expect(mgr.sendRequest('manager.spawn', { agent: 'codex' })).rejects.toThrow(
      'limit: 1 workers are already running',
    )
    expect(opened).toHaveLength(1)

    expect(first.paneId).toBeTruthy()
    dead.add(`worker-${workerSeq}`)
    await expect(mgr.sendRequest('manager.spawn', { agent: 'codex' })).resolves.toHaveProperty(
      'paneId',
    )
  })

  it('MGR-C37 stops at the spawn rate limit until the window passes', async () => {
    settings = {
      ...DEFAULT_MANAGER_SETTINGS,
      limits: { maxWorkers: 64, spawnsPer10Min: 2, busPerMinute: 60 },
    }
    const mgr = await client(managerPane.token)
    await mgr.sendRequest('manager.spawn', { agent: 'claude' })
    await mgr.sendRequest('manager.spawn', { agent: 'claude' })
    await expect(mgr.sendRequest('manager.spawn', { agent: 'claude' })).rejects.toThrow(
      'limit: at most 2 workers per 10 minutes',
    )
    now += 10 * 60 * 1000
    await expect(mgr.sendRequest('manager.spawn', { agent: 'claude' })).resolves.toHaveProperty(
      'paneId',
    )
  })

  it('MGR-C37 refuses an unknown preset and a relative cwd without opening anything', async () => {
    const mgr = await client(managerPane.token)
    await expect(mgr.sendRequest('manager.spawn', { agent: 'nope' })).rejects.toThrow(
      /unknown-agent: nope \(known: claude, codex\)/,
    )
    await expect(mgr.sendRequest('manager.spawn', { agent: 'claude', cwd: 'rel' })).rejects.toThrow(
      'bad-request: cwd',
    )
    expect(opened).toHaveLength(0)
  })

  it('MGR-C30 refuses to type into panes while manager.allowInput is off', async () => {
    const mgr = await client(managerPane.token)
    await expect(
      mgr.sendRequest('manager.input', { paneId: workerPane.externalId, text: 'y' }),
    ).rejects.toThrow('input-off')
    expect(written).toHaveLength(0)
  })

  it('MGR-C35 types text and named keys into another pane when allowInput is on', async () => {
    settings = { ...DEFAULT_MANAGER_SETTINGS, allowInput: true }
    const mgr = await client(managerPane.token)
    await mgr.sendRequest('manager.input', {
      paneId: workerPane.externalId,
      text: 'y',
      keys: ['enter', 'ctrl-c'],
    })
    expect(written).toEqual([{ paneId: 'plain-pane', data: 'y\r\x03' }])
    await expect(
      mgr.sendRequest('manager.input', { paneId: workerPane.externalId, keys: ['f13'] }),
    ).rejects.toThrow('unknown-key: f13')
    await expect(
      mgr.sendRequest('manager.input', { paneId: managerPane.externalId, text: 'x' }),
    ).rejects.toThrow('own-pane')
  })

  it('MGR-C37 limits the manager bus messages per minute', () => {
    settings = {
      ...DEFAULT_MANAGER_SETTINGS,
      limits: { maxWorkers: 8, spawnsPer10Min: 20, busPerMinute: 2 },
    }
    now = 1_000_000
    expect(limiter.busAllowed()).toBe(true)
    expect(limiter.busAllowed()).toBe(true)
    expect(limiter.busAllowed()).toBe(false)
    now += 60_000
    expect(limiter.busAllowed()).toBe(true)
  })
})

describe('manager docs', () => {
  it('MGR-C31 shows the manager verbs only to the manager', async () => {
    const worker = await client(workerPane.token)
    const mgr = await client(managerPane.token)
    const forWorker = await worker.sendRequest<{ cli: string }>('docs', {})
    const forManager = await mgr.sendRequest<{ cli: string }>('docs', {})
    expect(forWorker.cli).not.toContain('manager')
    expect(forManager.cli).toContain('ostia manager spawn')
  })
})

describe('RateWindow', () => {
  it('forgets stamps older than its window', () => {
    const window = new RateWindow(1000)
    expect(window.take(1, 0)).toBe(true)
    expect(window.take(1, 999)).toBe(false)
    expect(window.take(1, 1000)).toBe(true)
  })
})
