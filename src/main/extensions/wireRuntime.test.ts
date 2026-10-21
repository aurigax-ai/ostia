import { type SpawnOptions, spawn } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMessageConnection,
  ResponseError,
  SocketMessageReader,
  SocketMessageWriter,
} from 'vscode-jsonrpc/node'
import { answerWireRuntime, WIRE_CLIENT, WIRE_EXTENSION, WireRuntime } from './wireRuntime'

interface Spawned {
  file: string
  args: string[]
  options: SpawnOptions
}

const WIRE_BIN = realpathSync(
  join(
    dirname(createRequire(import.meta.url).resolve('@aurigax-ai/wire/package.json')),
    'dist',
    'cli',
    'bin.js',
  ),
)

const LEAKED_FD = 40

const pids: number[] = []
const servers: Server[] = []

afterEach(() => {
  for (const pid of pids.splice(0))
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  for (const server of servers.splice(0)) server.close()
})

function place(inherited?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-wire-'))
  const bin = join(dir, 'bin')
  const ran = join(dir, 'ran-from-path')
  mkdirSync(bin)
  for (const name of ['wire', 'graph', 'pnpm', 'npm', 'npx']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> '${ran}'\n`)
    chmodSync(join(bin, name), 0o755)
  }
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: dir,
    XDG_STATE_HOME: join(dir, 'state'),
    XDG_RUNTIME_DIR: join(dir, 'run'),
    TMPDIR: dir,
  }
  mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 })
  const pathEnv = {
    env,
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    home: dir,
    tmp: dir,
  }
  const paths =
    process.platform === 'darwin'
      ? {
          data: join(dir, 'Library', 'Application Support', 'wire'),
          socket: join(dir, 'wire', 'runtime.sock'),
        }
      : {
          data: join(env.XDG_STATE_HOME, 'wire'),
          socket: join(env.XDG_RUNTIME_DIR, 'wire', 'runtime.sock'),
        }
  const spawned: Spawned[] = []
  const runtime = new WireRuntime({
    nodePath: process.execPath,
    baseEnv: () => ({ ...env, OSTIA_TOKEN: 'pane-token', OSTIA_SOCKET: join(dir, 'ostia.sock') }),
    pathEnv: () => pathEnv,
    inheritableFds: () => (inherited === undefined ? [] : [LEAKED_FD]),
    spawn: (file, args, options) => {
      spawned.push({ file, args, options })
      if (inherited === undefined) return spawn(file, args, options)
      const stdio = Array.isArray(options.stdio)
        ? [...options.stdio]
        : [options.stdio, options.stdio, options.stdio]
      while (stdio.length <= LEAKED_FD) stdio.push('ignore')
      if (typeof stdio[LEAKED_FD] !== 'number') stdio[LEAKED_FD] = inherited
      return spawn(file, args, { ...options, stdio })
    },
  })
  const ranFromPath = () => (existsSync(ran) ? readFileSync(ran, 'utf8') : '')
  return { dir, env, paths, runtime, spawned, ranFromPath }
}

const RUNTIME_CONTRACT = 1

interface Hello {
  pid: number
  client: string
  rights: string[]
}

async function hello(socket: string, token: string): Promise<Hello> {
  const sock = connect(socket)
  await new Promise((resolve, reject) => sock.once('connect', resolve).once('error', reject))
  const conn = createMessageConnection(new SocketMessageReader(sock), new SocketMessageWriter(sock))
  conn.listen()
  try {
    const answer = await conn.sendRequest<Hello>('hello', { contract: RUNTIME_CONTRACT, token })
    pids.push(answer.pid)
    return answer
  } finally {
    conn.dispose()
    sock.destroy()
  }
}

function otherContract(socket: string): Promise<Server> {
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 })
  const server = createServer((sock) => {
    const conn = createMessageConnection(
      new SocketMessageReader(sock),
      new SocketMessageWriter(sock),
    )
    conn.onRequest('hello', () => {
      return new ResponseError(-32000, 'unsupported-contract', { contract: 2, version: '9.0.0' })
    })
    conn.listen()
  })
  servers.push(server)
  return new Promise((resolve) => server.listen(socket, () => resolve(server)))
}

describe('main starts and reaches the Wire runtime', () => {
  it('GRF-C226 with no runtime main starts wire runtime start from the bundled package, by argv with no shell and no OSTIA_* in its environment, and it answers within 5 s without running anything from PATH', async () => {
    const { paths, runtime, spawned, ranFromPath } = place()
    const began = Date.now()
    const answer = await runtime.connect()
    expect(answer).toMatchObject({ ok: true, started: true, socket: paths.socket })
    expect(Date.now() - began).toBeLessThan(5_000)
    expect(spawned).toHaveLength(1)
    const [start] = spawned as [Spawned]
    expect(start.file).toBe(process.execPath)
    expect([realpathSync(start.args[0] as string), ...start.args.slice(1)]).toEqual([
      WIRE_BIN,
      'runtime',
      'start',
    ])
    expect(start.options.shell).toBe(false)
    expect(Object.keys(start.options.env ?? {}).filter((n) => n.startsWith('OSTIA_'))).toEqual([])
    if (!answer.ok) return
    const { pid } = await hello(answer.socket, answer.token)
    if (process.platform === 'linux') {
      const environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
      expect(environ.filter((v) => v.startsWith('OSTIA_'))).toEqual([])
    }
    expect(ranFromPath()).toBe('')
  })

  it.runIf(process.platform === 'linux')(
    'GRF-C226 the runtime main starts holds none of the files main leaves inheritable',
    async () => {
      const held = join(mkdtempSync(join(tmpdir(), 'ostia-held-')), 'held-by-main')
      writeFileSync(held, '')
      const fd = openSync(held, 'r')
      const { runtime } = place(fd)
      try {
        const answer = await runtime.connect()
        if (!answer.ok) throw new Error(JSON.stringify(answer))
        const { pid } = await hello(answer.socket, answer.token)
        const open = readdirSync(`/proc/${pid}/fd`).map((n) => {
          try {
            return readlinkSync(`/proc/${pid}/fd/${n}`)
          } catch {
            return ''
          }
        })
        expect(open).not.toContain(held)
      } finally {
        closeSync(fd)
      }
    },
  )

  it('GRF-C227 a runtime of another contract on the socket is neither stopped nor replaced, its version is told, and nothing runs from PATH', async () => {
    const { paths, runtime, spawned, ranFromPath } = place()
    await otherContract(paths.socket)
    const inode = statSync(paths.socket).ino
    const answer = await runtime.connect()
    expect(answer).toEqual({ ok: false, error: 'other-contract', contract: 2, version: '9.0.0' })
    expect(spawned).toEqual([])
    expect(statSync(paths.socket).ino).toBe(inode)
    expect(servers[0]?.listening).toBe(true)
    expect(ranFromPath()).toBe('')
  })

  it('GRF-C230 a daemon of the same contract is reused and no second runtime starts', async () => {
    const { env, paths, runtime, spawned } = place()
    const daemon = spawn(process.execPath, [WIRE_BIN, 'runtime', 'start', '--daemon'], {
      env,
      stdio: 'ignore',
    })
    await new Promise((resolve) => daemon.on('exit', resolve))
    const lock = join(paths.data, 'runtime.lock')
    const before = readFileSync(lock, 'utf8').trim()
    pids.push(Number(before))
    const answer = await runtime.connect()
    expect(answer).toMatchObject({ ok: true, started: false, mode: 'daemon' })
    expect(spawned).toEqual([])
    expect(readFileSync(lock, 'utf8').trim()).toBe(before)
  })

  it('GRF-C232 main writes tokens/ostia and the runtime it starts takes it with enable and control', async () => {
    const { paths, runtime } = place()
    const answer = await runtime.connect()
    if (!answer.ok) throw new Error(JSON.stringify(answer))
    expect(existsSync(join(paths.data, 'tokens', WIRE_CLIENT))).toBe(true)
    const { client, rights } = await hello(answer.socket, answer.token)
    expect(client).toBe(WIRE_CLIENT)
    expect(rights).toEqual(expect.arrayContaining(['enable', 'control']))
  })

  it('GRF-C232 only the graphs built-in gets the runtime token; another built-in, a marketplace extension and no host get none', async () => {
    const ctx = { identity: {} as never, conn: {} as never }
    let connects = 0
    const runtime = {
      connect: async () => {
        connects += 1
        return { ok: false as const, error: 'not-started' as const, message: 'fake' }
      },
    }
    const host = (id: string | null) => ({ builtinId: () => id })
    await answerWireRuntime(host(WIRE_EXTENSION), runtime, ctx)
    expect(connects).toBe(1)
    for (const id of ['system', null])
      expect(await answerWireRuntime(host(id), runtime, ctx)).toMatchObject({
        ok: false,
        error: 'graphs-only',
      })
    expect(await answerWireRuntime(null, runtime, ctx)).toMatchObject({
      ok: false,
      error: 'no-extension-host',
    })
    expect(connects).toBe(1)
  })

  it.runIf(process.getuid?.() !== 0)(
    'GRF-C227 a socket that gives anything but refused or not there (EACCES) is left alone and nothing is started',
    async () => {
      const { paths, runtime, spawned, ranFromPath } = place()
      mkdirSync(dirname(paths.socket), { recursive: true, mode: 0o700 })
      const server = createServer(() => {})
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(paths.socket, resolve))
      chmodSync(paths.socket, 0)
      const inode = statSync(paths.socket).ino
      const answer = await runtime.connect()
      expect(answer).toMatchObject({ ok: false, error: 'not-started' })
      expect((answer as { message: string }).message).toContain('EACCES')
      expect(spawned).toEqual([])
      expect(statSync(paths.socket).ino).toBe(inode)
      expect(server.listening).toBe(true)
      expect(ranFromPath()).toBe('')
    },
  )
})
