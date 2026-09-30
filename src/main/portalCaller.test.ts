import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, type Socket, createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type CallerContext,
  callerVerdict,
  hasPineToken,
  judgeCaller,
  judgeCallers,
  listUnixSockets,
  parseProcStat,
  peerPidsFromSs,
  procFs,
} from './portalCaller'

interface FakeProc {
  ppid: number
  tty?: number
  env?: string[]
}

function fakeProc(procs: Record<number, FakeProc>) {
  return {
    read: (path: string): string | null => {
      const match = /^\/proc\/(\d+)\/(stat|environ)$/.exec(path)
      const proc = match ? procs[Number(match[1])] : undefined
      if (!match || !proc) return null
      if (match[2] === 'environ') return (proc.env ?? ['HOME=/home/u']).join('\0')
      return `${match[1]} (some (odd) name) S ${proc.ppid} 1 1 ${proc.tty ?? 0} 0 0`
    },
  }
}

function ctx(procs: Record<number, FakeProc>, paneTtys: number[] = []): CallerContext {
  return { mainPid: 100, paneTtys: new Set(paneTtys), proc: fakeProc(procs) }
}

describe('parseProcStat', () => {
  it('reads ppid and tty_nr after a command name with spaces and parentheses', () => {
    expect(parseProcStat('42 (a (b) c) S 7 42 42 34817 0')).toEqual({ ppid: 7, ttyNr: 34817 })
  })

  it('returns null for text that is not a stat line', () => {
    expect(parseProcStat('garbage')).toBeNull()
  })
})

describe('hasPineToken', () => {
  it('finds PINE_TOKEN among NUL-separated entries only as a variable name', () => {
    expect(hasPineToken('A=1\0PINE_TOKEN=abc\0')).toBe(true)
    expect(hasPineToken('A=PINE_TOKEN=abc\0NOT_PINE_TOKEN=1')).toBe(false)
  })
})

describe('judgeCaller', () => {
  it('MGR-C11 refuses a caller whose ancestor is the Pine main process', () => {
    const procs = { 300: { ppid: 200 }, 200: { ppid: 100 }, 100: { ppid: 1 } }
    expect(judgeCaller(300, ctx(procs))).toBe('inside')
  })

  it('MGR-C12 refuses a reparented caller that still carries PINE_TOKEN', () => {
    const procs = { 300: { ppid: 1, env: ['PINE_TOKEN=deadbeef'] } }
    expect(judgeCaller(300, ctx(procs))).toBe('inside')
  })

  it('MGR-C13 refuses a reparented caller whose controlling tty is a Pine pty', () => {
    const procs = { 300: { ppid: 1, tty: 34817 } }
    expect(judgeCaller(300, ctx(procs, [34817]))).toBe('inside')
  })

  it('MGR-C11 accepts a caller from a terminal outside Pine', () => {
    const procs = { 400: { ppid: 350, tty: 34900 }, 350: { ppid: 1 } }
    expect(judgeCaller(400, ctx(procs, [34817]))).toBe('outside')
  })

  it('MGR-C14 reports unknown when the caller process cannot be read', () => {
    expect(judgeCaller(999, ctx({}))).toBe('unknown')
  })

  it('stops at an ancestor it cannot read and treats the rest of the chain as outside', () => {
    const procs = { 400: { ppid: 350 } }
    expect(judgeCaller(400, ctx(procs))).toBe('outside')
  })
})

describe('judgeCallers', () => {
  it('MGR-C11 refuses when any process sharing the socket is inside Pine', () => {
    const procs = { 400: { ppid: 1 }, 300: { ppid: 100 } }
    expect(judgeCallers([400, 300], ctx(procs))).toBe('inside')
  })

  it('MGR-C14 reports unknown when no pid was found', () => {
    expect(judgeCallers([], ctx({}))).toBe('unknown')
  })
})

describe('peerPidsFromSs', () => {
  const output = [
    'u_str ESTAB 0 0 /run/user/1000/pine portal.sock 5001 * 5002 users:(("electron",pid=100,fd=40))',
    'u_str ESTAB 0 0 * 5002 * 5001 users:(("node",pid=400,fd=20),("node",pid=401,fd=20))',
    'u_str ESTAB 0 0 * 6002 * 6001 users:(("zsh",pid=500,fd=3))',
  ].join('\n')

  it('returns every pid holding the peer end of the server socket', () => {
    expect(peerPidsFromSs(output, 5001)).toEqual([400, 401])
  })

  it('MGR-C14 returns no pids when the server socket is not listed', () => {
    expect(peerPidsFromSs(output, 7001)).toEqual([])
  })
})

describe('callerVerdict (real socket, real ss)', () => {
  let dir = ''
  let server: Server | null = null

  afterEach(() => {
    server?.close()
    server = null
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  function listen(): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), 'pine-portal-test-'))
    const path = join(dir, 'p.sock')
    server = createServer()
    return new Promise((resolve) => server?.listen(path, () => resolve(path)))
  }

  function nextConnection(): Promise<Socket> {
    return new Promise((resolve) => server?.once('connection', resolve))
  }

  const verdictFor = (socket: Socket, mainPid: number) =>
    callerVerdict(socket, { mainPid, paneTtys: new Set(), proc: procFs })

  it.runIf(process.platform === 'linux')(
    'MGR-C11 judges a child of the main pid as inside and the same child as outside for another main',
    async () => {
      if ((await listUnixSockets()) === null) return
      const path = await listen()
      const accepted = nextConnection()
      const child = spawn(
        process.execPath,
        [
          '-e',
          `require('net').createConnection(${JSON.stringify(path)}); setTimeout(() => {}, 5000)`,
        ],
        { env: { PATH: process.env.PATH ?? '' }, stdio: 'ignore' },
      )
      try {
        const socket = await accepted
        expect(await verdictFor(socket, process.pid)).toBe('inside')
        expect(await verdictFor(socket, -1)).toBe('outside')
      } finally {
        child.kill()
      }
    },
  )

  it.runIf(process.platform === 'linux')('MGR-C14 is unknown when ss cannot run', async () => {
    const path = await listen()
    const accepted = nextConnection()
    const client = createConnection(path)
    try {
      const socket = await accepted
      const verdict = await callerVerdict(
        socket,
        { mainPid: process.pid, paneTtys: new Set(), proc: procFs },
        async () => null,
      )
      expect(verdict).toBe('unknown')
    } finally {
      client.destroy()
    }
  })
})
