import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'
import { gitRequest } from '../../cli/verbs/coreBoards'
import type { CommandDescriptor, CommandResult, CommandTarget } from '../../shared/control/commands'
import type { TerminalStateSnapshot } from '../../shared/terminal/ptyApi'
import { grant } from '../approvals/capabilityStore'
import {
  type ControlServerDeps,
  controlSocketPathFor,
  keptControlSocketPath,
  keptControlSocketPaths,
  legacyKeptControlSocketPath,
  listenKeptControlSocket,
  registerControlServer,
  stopControlServer,
  sweepStaleControlSockets,
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

  it('runs a socket command inside byAgent, so what it changes counts as the agent’s doing', async () => {
    socketPath = nextSocketPath()
    const id = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pGrouper' })
    const steps: string[] = []
    registerControlServer(
      {
        ...fakeDeps,
        execCommand: async () => {
          steps.push('exec')
          return { ok: true } as CommandResult
        },
        byAgent: async (run) => {
          steps.push('agent-start')
          try {
            return await run()
          } finally {
            steps.push('agent-end')
          }
        },
      },
      socketPath,
    )
    client = connectClient(socketPath)
    await client.conn.sendRequest('hello', { token: id.token })

    await client.conn.sendRequest('command.exec', { id: 'pane.splitRight' })

    expect(steps).toEqual(['agent-start', 'exec', 'agent-end'])
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

  it('serves kept shells on every kept path, including the one from before the move', async () => {
    socketPath = nextSocketPath()
    const id = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pTest1' })
    registerControlServer(fakeDeps, socketPath)
    const moved = nextSocketPath()
    const legacy = nextSocketPath()
    listenKeptControlSocket([moved, legacy])
    await expect.poll(() => existsSync(moved) && existsSync(legacy)).toBe(true)
    for (const path of [moved, legacy]) {
      const kept = connectClient(path)
      await expect(kept.conn.sendRequest('hello', { token: id.token })).resolves.toEqual({
        externalId: id.externalId,
      })
      kept.destroy()
    }
    stopControlServer()
    expect(existsSync(moved)).toBe(false)
    expect(existsSync(legacy)).toBe(false)
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

const runDirs: string[] = []
afterEach(() => {
  for (const dir of runDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function dataHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-'))
  runDirs.push(dir)
  return dir
}

describe('the control socket on macOS', () => {
  it('lives in the app data folder, outside TMPDIR, under the sun_path limit', () => {
    const data = dataHome()
    const path = controlSocketPathFor(99999, 'darwin', { XDG_DATA_HOME: data })
    expect(path).toBe(join(data, 'ostia', 'run', 'control', 'ostia-99999.sock'))
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(103)
    const folder = lstatSync(dirname(path))
    expect(folder.mode & 0o777).toBe(0o700)
    expect(folder.uid).toBe(process.getuid?.())
  })

  it('stays in XDG_RUNTIME_DIR on Linux', () => {
    expect(controlSocketPathFor(42, 'linux', { XDG_RUNTIME_DIR: '/run/user/1000' })).toBe(
      '/run/user/1000/ostia-42.sock',
    )
  })

  it('puts the kept socket next to it, and finds the old TMPDIR one only when it exists', () => {
    const data = dataHome()
    const kept = keptControlSocketPath('/data/ostia-a', 'darwin', { XDG_DATA_HOME: data })
    expect(dirname(kept)).toBe(join(data, 'ostia', 'run', 'kept'))
    const tmp = dataHome()
    expect(legacyKeptControlSocketPath('/data/ostia-a', 'darwin', tmp)).toBeNull()
    expect(legacyKeptControlSocketPath('/data/ostia-a', 'linux', tmp)).toBeNull()
    const old = join(tmp, `ostia-kept-${process.getuid?.()}`)
    mkdirSync(old)
    expect(legacyKeptControlSocketPath('/data/ostia-a', 'darwin', tmp)).toBe(
      join(old, kept.slice(dirname(kept).length + 1)),
    )
  })

  it('removes the sockets of Ostia processes that are gone, and nothing else', () => {
    const data = dataHome()
    const dir = dirname(controlSocketPathFor(1, 'darwin', { XDG_DATA_HOME: data }))
    for (const name of ['ostia-111.sock', 'ostia-222.sock', 'notes.txt', 'ostia-x.sock']) {
      writeFileSync(join(dir, name), '')
    }
    sweepStaleControlSockets('darwin', { XDG_DATA_HOME: data }, (pid) => pid === 222)
    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'ostia-222.sock', 'ostia-x.sock'])
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
    expect(keptControlSocketPaths('/data/ostia-a')[0]).toBe(path)
  })
})

const SRC_DIR = join(__dirname, '..', '..')
const CLI_PORTAL = join(SRC_DIR, 'cli', 'verbs', 'portal.ts')
const MAIN_PORTAL = join(SRC_DIR, 'main', 'manager', 'portal.ts')
const CLI_GIT = join(SRC_DIR, 'cli', 'verbs', 'coreBoards.ts')

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return productionFiles(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts')
      ? [path]
      : []
  })
}

function controlSources(dir: string, portal: string): string[] {
  return productionFiles(join(SRC_DIR, dir))
    .filter((f) => f !== portal)
    .map((f) => readFileSync(f, 'utf8'))
}

function literals(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1])
}

function registeredMethods(): Set<string> {
  const names = new Set<string>()
  const files = productionFiles(join(SRC_DIR, 'main')).filter((f) => f !== MAIN_PORTAL)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const name of literals(
      text,
      /(?:registerControlMethod|registerTargetableMethod|conn\.onRequest|onCall)\(\s*'([^'\n]+)'/g,
    )) {
      names.add(name)
    }
    for (const prefix of literals(
      text,
      /(?:registerControlMethod|registerTargetableMethod)\(\s*`([a-z]+\.)\$\{name\}`/g,
    )) {
      for (const sibling of files.filter((f) => dirname(f) === dirname(file))) {
        for (const name of literals(
          readFileSync(sibling, 'utf8'),
          /^\s*(?:method|keyMethod|bufferMethod)\(\s*'([^'\n]+)'/gm,
        ))
          names.add(prefix + name)
      }
    }
  }
  return names
}

function gitSubcommands(): string[] {
  const text = readFileSync(CLI_GIT, 'utf8')
  const start = text.indexOf('export function gitRequest(')
  const body = text.slice(start, text.indexOf('\n}\n', start))
  return literals(body, /\bcase '([\w-]+)':/g)
}

function gitMethod(sub: string): string | null {
  for (const argv of [[sub], [sub, 'path'], [sub, '-m', 'message']]) {
    const request = gitRequest(argv)
    if (request) return request.method
  }
  return null
}

function sentMethods(): Set<string> {
  const names = new Set<string>()
  for (const text of controlSources('cli', CLI_PORTAL)) {
    for (const name of literals(text, /sendRequest\b[^(]*\(\s*'([^'\n]+)'/g)) names.add(name)
    for (const name of literals(text, /method: '([a-z]+\.[a-zA-Z.]+)'/g)) names.add(name)
    for (const name of literals(text, /\bok\([^,\n]+,\s*'([a-z]+\.[a-zA-Z]+)'/g)) names.add(name)
    for (const m of text.matchAll(
      /\b(?:plainVerb|targetVerb|keyVerb|textVerb|bufferVerb)\(\s*'([\w-]+)'(?:,\s*'(\w+)')?\)/g,
    )) {
      names.add(`browse.${m[2] ?? m[1]}`)
    }
  }
  for (const sub of gitSubcommands()) {
    const method = gitMethod(sub)
    if (method) names.add(method)
  }
  return names
}

function portalNames(file: string, call: string): Set<string> {
  const re = new RegExp(`\\b${call}\\b[^(]*\\(\\s*'([^'\\n]+)'`, 'g')
  return new Set(literals(readFileSync(file, 'utf8'), re))
}

function missingFrom(wanted: Set<string>, have: Set<string>): string[] {
  return [...wanted].filter((name) => !have.has(name)).sort()
}

describe('CLI and control server wiring', () => {
  const registered = registeredMethods()
  const sent = sentMethods()

  it('reads a plausible number of methods from both sides', () => {
    expect(registered.size).toBeGreaterThan(90)
    expect(sent.size).toBeGreaterThan(60)
  })

  it('turns every git subcommand the CLI parses into a request', () => {
    const subs = gitSubcommands()
    expect(subs.length).toBeGreaterThan(8)
    expect(subs.filter((sub) => gitMethod(sub) === null)).toEqual([])
  })

  it('registers every method the CLI sends', () => {
    expect(missingFrom(sent, registered)).toEqual([])
  })
})

describe('CLI and manager portal wiring', () => {
  it('reads both ends of the portal socket', () => {
    expect(portalNames(CLI_PORTAL, 'sendRequest').size).toBeGreaterThan(0)
    expect(portalNames(CLI_PORTAL, 'sendNotification').size).toBeGreaterThan(0)
    expect(portalNames(MAIN_PORTAL, 'sendNotification').size).toBeGreaterThan(0)
  })

  it('handles every request the CLI sends', () => {
    expect(
      missingFrom(portalNames(CLI_PORTAL, 'sendRequest'), portalNames(MAIN_PORTAL, 'onRequest')),
    ).toEqual([])
  })

  it('handles every notification the CLI sends', () => {
    expect(
      missingFrom(
        portalNames(CLI_PORTAL, 'sendNotification'),
        portalNames(MAIN_PORTAL, 'onNotification'),
      ),
    ).toEqual([])
  })

  it('listens for every notification main sends', () => {
    expect(
      missingFrom(
        portalNames(MAIN_PORTAL, 'sendNotification'),
        portalNames(CLI_PORTAL, 'onNotification'),
      ),
    ).toEqual([])
  })
})
