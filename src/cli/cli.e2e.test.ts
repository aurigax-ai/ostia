import { execSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type ControlServerDeps,
  registerControlServer,
  stopControlServer,
} from '../main/controlServer'
import { type PaneIdentity, registerPane } from '../main/idRegistry'
import type { CommandDescriptor, CommandResult } from '../shared/types'

const repoRoot = process.cwd()
const cliPath = join(repoRoot, 'out', 'cli', 'index.js')

let socketCounter = 0
function nextSocketPath(): string {
  socketCounter += 1
  return join(tmpdir(), `pine-cli-e2e-${process.pid}-${socketCounter}.sock`)
}

const fakeDeps: ControlServerDeps = {
  execCommand: async (_target, id) => ({ ok: true, result: { ran: id } }) as CommandResult,
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
  }, 60_000)

  let socketPath: string
  let identity: PaneIdentity

  beforeEach(() => {
    socketPath = nextSocketPath()
    identity = registerPane({ windowId: 'w1', sessionId: 's1', paneId: 'pE2E' })
    registerControlServer(fakeDeps, socketPath)
  })

  afterEach(() => {
    stopControlServer()
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
})
