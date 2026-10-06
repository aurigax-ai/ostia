import { existsSync, lstatSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node'
import type {
  CommandDescriptor,
  CommandResult,
  CommandTarget,
  TerminalStateSnapshot,
} from '../shared/types'
import { grant } from './capabilityStore'
import {
  type ControlServerDeps,
  keptControlSocketPath,
  registerControlServer,
  stopControlServer,
} from './controlServer'
import { registerPane } from './idRegistry'

let socketCounter = 0
function nextSocketPath(): string {
  socketCounter += 1
  return join(tmpdir(), `ostia-test-${process.pid}-${socketCounter}.sock`)
}

const fakeDeps: ControlServerDeps = {
  execCommand: async () => ({ ok: true, result: 'did-it' }) as CommandResult,
  listCommandsFor: () =>
    [
      {
        id: 'pane.splitRight',
        title: 'x',
        category: null,
        hidden: false,
        argsSchema: null,
        resultSchema: null,
        capabilities: ['drive-self'],
        target: 'active',
      },
    ] as CommandDescriptor[],
  getTerminalState: () =>
    ({ paneId: 'pTest1', generation: 1, running: false, blockCount: 0 }) as TerminalStateSnapshot,
}

function connectClient(path: string): { conn: MessageConnection; destroy: () => void } {
  const socket = createConnection(path)
  const conn = createMessageConnection(
    new StreamMessageReader(socket),
    new StreamMessageWriter(socket),
  )
  conn.listen()
  return { conn, destroy: () => socket.destroy() }
}

describe('controlServer (socket auth, end-to-end)', () => {
  let socketPath: string
  let client: { conn: MessageConnection; destroy: () => void } | null = null

  afterEach(() => {
    client?.destroy()
    client = null
    stopControlServer()
  })

  it('accepts hello with the real token, then serves whoami/command.exec/command.list', async () => {
    socketPath = nextSocketPath()
    const id = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pTest1' })
    registerControlServer(fakeDeps, socketPath)
    client = connectClient(socketPath)

    const helloRes = await client.conn.sendRequest('hello', { token: id.token })
    expect(helloRes).toEqual({ externalId: id.externalId })

    const who = await client.conn.sendRequest('whoami')
    expect(who).toEqual({ externalId: id.externalId, paneId: 'pTest1', workspaceId: 's1' })

    const execRes = await client.conn.sendRequest('command.exec', { id: 'pane.splitRight' })
    expect(execRes).toEqual({ ok: true, result: 'did-it' })

    const list = await client.conn.sendRequest('command.list')
    expect(list).toEqual([
      {
        id: 'pane.splitRight',
        title: 'x',
        category: null,
        hidden: false,
        argsSchema: null,
        resultSchema: null,
        capabilities: ['drive-self'],
        target: 'active',
      },
    ])
  })

  it('requires all-workspaces to target another workspace, even from the caller own pane', async () => {
    socketPath = nextSocketPath()
    const id = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pTest1' })
    registerControlServer(fakeDeps, socketPath)
    client = connectClient(socketPath)
    await client.conn.sendRequest('hello', { token: id.token })

    const target = { windowId: 'w1', workspaceId: 's-other', paneId: 'pTest1' }
    await expect(
      client.conn.sendRequest('command.exec', { id: 'pane.splitRight', target }),
    ).rejects.toThrow(/all-workspaces/)
  })

  it('resolves a target given only by workspace to the window that shows it, once granted', async () => {
    socketPath = nextSocketPath()
    const id = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pTestReach' })
    const executed: CommandTarget[] = []
    registerControlServer(
      {
        ...fakeDeps,
        execCommand: async (target) => {
          executed.push(target)
          return { ok: true } as CommandResult
        },
        windowOfWorkspace: (workspaceId) => (workspaceId === 's-far' ? 'w2' : undefined),
      },
      socketPath,
    )
    client = connectClient(socketPath)
    await client.conn.sendRequest('hello', { token: id.token })

    const target = { workspaceId: 's-far', paneId: null }
    await expect(
      client.conn.sendRequest('command.exec', { id: 'pane.splitRight', target }),
    ).rejects.toThrow(/all-workspaces/)
    expect(executed).toEqual([])

    grant(id.externalId, 'all-workspaces')
    await client.conn.sendRequest('command.exec', { id: 'pane.splitRight', target })
    expect(executed).toEqual([{ windowId: 'w2', workspaceId: 's-far', paneId: null }])

    await expect(
      client.conn.sendRequest('command.exec', {
        id: 'pane.splitRight',
        target: { workspaceId: 's-gone', paneId: null },
      }),
    ).rejects.toThrow('unknown-workspace: s-gone')
    expect(executed).toHaveLength(1)
  })

  it('rejects hello with a bogus token', async () => {
    socketPath = nextSocketPath()
    registerControlServer(fakeDeps, socketPath)
    client = connectClient(socketPath)

    await expect(client.conn.sendRequest('hello', { token: 'bogus-token' })).rejects.toThrow()
  })

  it('rejects whoami before a successful hello', async () => {
    socketPath = nextSocketPath()
    registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pTest1' })
    registerControlServer(fakeDeps, socketPath)
    client = connectClient(socketPath)

    await expect(client.conn.sendRequest('whoami')).rejects.toThrow()
  })

  it('removes the socket file after stopControlServer', async () => {
    socketPath = nextSocketPath()
    const id = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pTest1' })
    registerControlServer(fakeDeps, socketPath)
    client = connectClient(socketPath)
    await client.conn.sendRequest('hello', { token: id.token })

    expect(existsSync(socketPath)).toBe(true)
    client.destroy()
    client = null
    stopControlServer()
    expect(existsSync(socketPath)).toBe(false)
  })
})

describe('keptControlSocketPath', () => {
  it('puts the kept socket in a folder only its owner can open, under a stable name', () => {
    const path = keptControlSocketPath('/data/ostia-a')
    const folder = lstatSync(dirname(path))
    expect(folder.isDirectory()).toBe(true)
    expect(folder.mode & 0o777).toBe(0o700)
    expect(folder.uid).toBe(process.getuid?.())
    expect(keptControlSocketPath('/data/ostia-a')).toBe(path)
    expect(keptControlSocketPath('/data/ostia-b')).not.toBe(path)
  })
})
