import { execSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { registerAttentionMethods } from '../main/attention'
import { grant } from '../main/capabilityStore'
import {
  type ControlServerDeps,
  registerControlMethod,
  registerControlServer,
  stopControlServer,
} from '../main/controlServer'
import { type PaneIdentity, registerPane } from '../main/idRegistry'
import type { CommandDescriptor, CommandResult, CommandTarget } from '../shared/types'

const repoRoot = process.cwd()
const cliPath = join(repoRoot, 'out', 'cli', 'index.js')

let socketCounter = 0
function nextSocketPath(): string {
  socketCounter += 1
  return join(tmpdir(), `pine-cli-e2e-${process.pid}-${socketCounter}.sock`)
}

const execCalls: { target: CommandTarget; id: string; args?: unknown }[] = []

const fakeDeps: ControlServerDeps = {
  execCommand: async (target, id, args) => {
    execCalls.push({ target, id, args })
    return { ok: true, result: { ran: id } } as CommandResult
  },
  listCommandsFor: () =>
    [
      {
        id: 'pane.splitRight',
        title: 'Split Right',
        category: null,
        hidden: false,
        argsSchema: null,
        resultSchema: null,
        capabilities: ['drive-self'],
        target: 'active',
      },
    ] as CommandDescriptor[],
  getTerminalState: () => undefined,
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function withEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key]
    else merged[key] = value
  }
  return merged
}

const liveChildren = new Set<ReturnType<typeof spawn>>()

function runPine(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env })
    liveChildren.add(child)
    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(
        new Error(`pine ${args.join(' ')} timed out after 10s (stdout=${stdout} stderr=${stderr})`),
      )
    }, 10_000)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      liveChildren.delete(child)
      reject(err)
    })
    child.on('close', (code) => {
      liveChildren.delete(child)
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

describe('pine CLI end-to-end (spawns the real out/cli/index.js against a live control server)', () => {
  beforeAll(() => {
    execSync('pnpm run build:cli', { cwd: repoRoot, stdio: 'ignore' })
    registerAttentionMethods({ execCommand: fakeDeps.execCommand })
  }, 60_000)

  let socketPath: string
  let identity: PaneIdentity

  beforeEach(() => {
    socketPath = nextSocketPath()
    identity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pE2E' })
    registerControlServer(fakeDeps, socketPath)
  })

  afterEach(() => {
    stopControlServer()
    execCalls.length = 0
  })

  afterAll(() => {
    for (const child of liveChildren) child.kill('SIGKILL')
    liveChildren.clear()
  })

  it('whoami: prints the minted identity as JSON and exits 0', async () => {
    const res = await runPine(
      ['whoami'],
      withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
    )

    expect(res.stderr).toBe('')
    expect(res.code).toBe(0)
    const parsed = JSON.parse(res.stdout)
    expect(parsed.externalId).toBe(identity.externalId)
    expect(parsed.paneId).toBe('pE2E')
  })

  it('commands: lists the descriptors served by the control server and exits 0', async () => {
    const res = await runPine(
      ['commands'],
      withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
    )

    expect(res.code).toBe(0)
    expect(res.stdout).toContain('pane.splitRight')
    const parsed = JSON.parse(res.stdout) as CommandDescriptor[]
    expect(parsed.some((d) => d.id === 'pane.splitRight')).toBe(true)
  })

  it('pane.splitRight: dispatches command.exec through the real socket and exits 0', async () => {
    const res = await runPine(
      ['pane.splitRight'],
      withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
    )

    expect(res.code).toBe(0)
    expect(res.stdout).toContain('ok')
    expect(res.stdout).toContain('{"ran":"pane.splitRight"}')
  })

  it('pane.bogus: unknown command id surfaces as a non-zero exit + stderr message', async () => {
    const res = await runPine(
      ['pane.bogus'],
      withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
    )

    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain("unknown command 'pane.bogus'")
  })

  it('with PINE_SOCKET unset: fails fast with a "not inside a Pine pane" message', async () => {
    const res = await runPine(
      ['whoami'],
      withEnv({ PINE_SOCKET: undefined, PINE_TOKEN: undefined }),
    )

    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain('not inside a Pine pane')
  })

  it('--help / -h print usage without contacting the app', async () => {
    for (const flag of ['--help', '-h']) {
      const res = await runPine([flag], withEnv({ PINE_SOCKET: undefined, PINE_TOKEN: undefined }))
      expect(res.code).toBe(0)
      expect(res.stdout).toContain('usage: pine')
    }
  })

  it('stale PINE_SOCKET: prints "app not reachable" and exits 1 without a stack trace', async () => {
    const stale = join(tmpdir(), `pine-cli-e2e-${process.pid}-stale.sock`)
    const res = await runPine(['whoami'], withEnv({ PINE_SOCKET: stale, PINE_TOKEN: 'x' }))

    expect(res.code).toBe(1)
    expect(res.stderr.trim()).toBe(`pine: app not reachable at ${stale}`)
  })

  it('exits 1 with a clear message when the app closes the socket mid-request', async () => {
    const dropPath = nextSocketPath()
    const server = createServer((sock) => sock.once('data', () => sock.destroy()))
    await new Promise<void>((resolve) => server.listen(dropPath, resolve))
    try {
      const res = await runPine(
        ['bus', 'wait'],
        withEnv({ PINE_SOCKET: dropPath, PINE_TOKEN: 'x' }),
      )
      expect(res.code).toBe(1)
      expect(res.stderr).toContain('connection to the app closed')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('open with no path: exits 1 with a usage error', async () => {
    const res = await runPine(
      ['open'],
      withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
    )

    expect(res.code).toBe(1)
    expect(res.stderr).toContain('pine open: missing <path>')
  })

  it('rejects a non-numeric numeric flag instead of silently defaulting', async () => {
    const res = await runPine(
      ['bus', 'wait', '--timeout', 'soon'],
      withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
    )

    expect(res.code).toBe(1)
    expect(res.stderr).toContain("--timeout expects a number, got 'soon'")
  })

  describe('pine state', () => {
    const env = () => withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token })

    it('sets the attention of the caller own pane with a message', async () => {
      const res = await runPine(['state', 'waiting', 'approve the migration?'], env())

      expect(res.stderr).toBe('')
      expect(res.code).toBe(0)
      expect(execCalls).toEqual([
        {
          target: { windowId: 'w1', workspaceId: 's1', paneId: 'pE2E' },
          id: 'attention.set',
          args: { state: 'waiting', message: 'approve the migration?' },
        },
      ])
    })

    it('maps clear to none', async () => {
      const res = await runPine(['state', 'clear'], env())
      expect(res.code).toBe(0)
      expect(execCalls[0]?.args).toEqual({ state: 'none' })
    })

    it('reads the message from a Claude Code hook payload on stdin with -', async () => {
      const child = spawn(process.execPath, [cliPath, 'state', 'waiting', '-'], { env: env() })
      child.stdin.end(
        JSON.stringify({
          hook_event_name: 'Notification',
          message: 'Claude needs your permission',
        }),
      )
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
      expect(code).toBe(0)
      expect(execCalls[0]?.args).toEqual({
        state: 'waiting',
        message: 'Claude needs your permission',
      })
    })

    it('rejects an unknown state before touching the app', async () => {
      const res = await runPine(['state', 'sleeping'], env())
      expect(res.code).toBe(1)
      expect(res.stderr).toContain('pine state: expected one of waiting|done|working|error|clear')
      expect(execCalls).toHaveLength(0)
    })

    it('needs all-workspaces to set another pane, and targets it once granted', async () => {
      const other = registerPane({ windowId: 'w1', workspaceId: 's2', paneId: 'pOther' })
      const denied = await runPine(['state', 'done', '--pane', other.externalId], env())
      expect(denied.code).toBe(1)
      expect(denied.stderr).toContain('needs-elevation: all-workspaces')
      expect(execCalls).toHaveLength(0)

      grant(identity.externalId, 'all-workspaces')
      const allowed = await runPine(['state', 'done', '--pane', other.externalId], env())
      expect(allowed.code).toBe(0)
      expect(execCalls[0]?.target).toEqual({ windowId: 'w1', workspaceId: 's2', paneId: 'pOther' })
    })
  })

  describe('pine browse storage', () => {
    const received: unknown[] = []
    beforeAll(() => {
      registerControlMethod('browse.storage', {
        cap: 'browse',
        handler: async (params: unknown) => {
          received.push(params)
          return { ok: true, value: 'v' }
        },
      })
    })

    it('reads the browser sessionStorage area as "session", not a Pine workspace', async () => {
      grant(identity.externalId, 'browse')
      const res = await runPine(
        ['browse', 'storage', 'session', 'get', 'token'],
        withEnv({ PINE_SOCKET: socketPath, PINE_TOKEN: identity.token }),
      )
      expect(res.stderr).toBe('')
      expect(res.code).toBe(0)
      expect(received.at(-1)).toMatchObject({ area: 'session', sub: 'get', key: 'token' })
    })
  })
})
