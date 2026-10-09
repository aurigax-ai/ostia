import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
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
import { gitRequest } from '../../cli/verbs/coreBoards'
import type {
  CommandDescriptor,
  CommandResult,
  CommandTarget,
  TerminalStateSnapshot,
} from '../../shared/types'
import { grant } from '../approvals/capabilityStore'
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

const sandboxedWorkspaces = new Set<string>()

const fakeDeps: ControlServerDeps = {
  isSandboxed: (workspaceId) => sandboxedWorkspaces.has(workspaceId),
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
    sandboxedWorkspaces.clear()
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

  it('hands the app the inner id of a pane named by its pane.list id, so pane.close finds it', async () => {
    socketPath = nextSocketPath()
    const me = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pCloser' })
    const other = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pToClose' })
    const executed: { target: CommandTarget; args: unknown }[] = []
    registerControlServer(
      {
        ...fakeDeps,
        execCommand: async (target, _id, args) => {
          executed.push({ target, args })
          return { ok: true } as CommandResult
        },
      },
      socketPath,
    )
    client = connectClient(socketPath)
    await client.conn.sendRequest('hello', { token: me.token })

    expect(other.externalId).not.toBe('pToClose')
    await client.conn.sendRequest('command.exec', {
      id: 'pane.splitRight',
      args: { paneId: other.externalId },
    })
    expect(executed).toEqual([
      {
        target: { windowId: 'w1', workspaceId: 's1', paneId: 'pCloser' },
        args: { paneId: 'pToClose' },
      },
    ])
  })

  it('refuses a paneId no pane has instead of running the command on nothing', async () => {
    socketPath = nextSocketPath()
    const me = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pAsker' })
    const executed: unknown[] = []
    registerControlServer(
      {
        ...fakeDeps,
        execCommand: async (_target, _id, args) => {
          executed.push(args)
          return { ok: true } as CommandResult
        },
      },
      socketPath,
    )
    client = connectClient(socketPath)
    await client.conn.sendRequest('hello', { token: me.token })

    await expect(
      client.conn.sendRequest('command.exec', {
        id: 'pane.splitRight',
        args: { paneId: 'not-a-pane' },
      }),
    ).rejects.toThrow('unknown-pane: not-a-pane')
    expect(executed).toEqual([])
  })

  it('runs a command on a pane in another workspace there, and only with all-workspaces', async () => {
    socketPath = nextSocketPath()
    const me = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pHere' })
    const far = registerPane({ windowId: 'w2', workspaceId: 's-far', paneId: 'pFar' })
    const executed: { target: CommandTarget; args: unknown }[] = []
    registerControlServer(
      {
        ...fakeDeps,
        execCommand: async (target, _id, args) => {
          executed.push({ target, args })
          return {
            ok: false,
            error: { code: 'command-failed', message: 'unknown-pane: pFar' },
          } as CommandResult
        },
      },
      socketPath,
    )
    client = connectClient(socketPath)
    await client.conn.sendRequest('hello', { token: me.token })
    const call = { id: 'pane.splitRight', args: { paneId: far.externalId } }

    await expect(client.conn.sendRequest('command.exec', call)).rejects.toThrow(/all-workspaces/)
    expect(executed).toEqual([])

    grant(me.externalId, 'all-workspaces')
    const res = await client.conn.sendRequest<CommandResult>('command.exec', call)
    expect(executed).toEqual([
      { target: { windowId: 'w2', workspaceId: 's-far', paneId: null }, args: { paneId: 'pFar' } },
    ])
    expect(res.ok ? '' : res.error.message).toBe(`unknown-pane: ${far.externalId}`)

    await expect(
      client.conn.sendRequest('command.exec', {
        ...call,
        target: { workspaceId: 's1', paneId: null },
      }),
    ).rejects.toThrow(`pane ${far.externalId} is in workspace s-far, not s1`)
  })

  it('refuses a sandboxed caller any command in another workspace, even with all-workspaces', async () => {
    socketPath = nextSocketPath()
    sandboxedWorkspaces.add('s-box')
    const me = registerPane({ windowId: 'w1', workspaceId: 's-box', paneId: 'pBoxed' })
    const far = registerPane({ windowId: 'w2', workspaceId: 's-far', paneId: 'pFarAway' })
    grant(me.externalId, 'all-workspaces')
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
    await client.conn.sendRequest('hello', { token: me.token })
    const refusal =
      'sandboxed: a sandboxed workspace reaches only the sandboxed terminals of its own workspace'

    await expect(
      client.conn.sendRequest('command.exec', {
        id: 'tab.new',
        target: { workspaceId: 's-far', paneId: null },
      }),
    ).rejects.toThrow(refusal)
    await expect(
      client.conn.sendRequest('command.exec', {
        id: 'pane.splitRight',
        args: { paneId: far.externalId },
      }),
    ).rejects.toThrow(refusal)
    expect(executed).toEqual([])

    await client.conn.sendRequest('command.exec', { id: 'pane.splitRight' })
    expect(executed).toEqual([{ windowId: 'w1', workspaceId: 's-box', paneId: 'pBoxed' }])
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

const SRC_DIR = join(__dirname, '..', '..')

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return productionFiles(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts')
      ? [path]
      : []
  })
}

function readSources(dir: string): Map<string, string> {
  return new Map(productionFiles(join(SRC_DIR, dir)).map((f) => [f, readFileSync(f, 'utf8')]))
}

function literals(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1])
}

function registeredMethods(): Set<string> {
  const names = new Set<string>()
  for (const text of readSources('main').values()) {
    for (const name of literals(
      text,
      /(?:registerControlMethod|registerTargetableMethod|conn\.onRequest)\(\s*'([^'\n]+)'/g,
    )) {
      names.add(name)
    }
    for (const prefix of literals(
      text,
      /(?:registerControlMethod|registerTargetableMethod)\(\s*`([a-z]+\.)\$\{name\}`/g,
    )) {
      for (const name of literals(text, /^\s*(?:method|keyMethod|bufferMethod)\(\s*'([^'\n]+)'/gm))
        names.add(prefix + name)
    }
  }
  return names
}

function sentMethods(): Set<string> {
  const names = new Set<string>()
  for (const text of readSources('cli').values()) {
    for (const name of literals(text, /sendRequest\b[^(]*\(\s*'([^'\n]+)'/g)) names.add(name)
    for (const name of literals(text, /method: '([a-z]+\.[a-zA-Z.]+)'/g)) names.add(name)
    for (const name of literals(text, /\bok\([^,\n]+,\s*'([a-z]+\.[a-zA-Z]+)'/g)) names.add(name)
    for (const m of text.matchAll(
      /\b(?:plainVerb|targetVerb|keyVerb|textVerb|bufferVerb)\(\s*'([\w-]+)'(?:,\s*'(\w+)')?\)/g,
    )) {
      names.add(`browse.${m[2] ?? m[1]}`)
    }
  }
  for (const sub of ['status', 'changes', 'diff', 'open', 'log', 'blame', 'stage', 'unstage']) {
    for (const argv of [[sub], [sub, 'path']]) {
      const request = gitRequest(argv)
      if (request) names.add(request.method)
    }
  }
  const commit = gitRequest(['commit', '-m', 'message'])
  if (commit) names.add(commit.method)
  return names
}

describe('CLI and control server wiring', () => {
  const registered = registeredMethods()
  const sent = sentMethods()

  it('reads a plausible number of methods from both sides', () => {
    expect(registered.size).toBeGreaterThan(90)
    expect(sent.size).toBeGreaterThan(60)
  })

  it('registers every method the CLI sends', () => {
    expect([...sent].filter((name) => !registered.has(name)).sort()).toEqual([])
  })
})
