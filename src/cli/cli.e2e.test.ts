/**
 * True end-to-end proof that the built `pine` CLI binary (`out/cli/index.js`) talks to the
 * control-plane Unix socket exactly the way a real pane's env (`PINE_SOCKET`/`PINE_TOKEN`)
 * would drive it. `controlServer.test.ts` unit-tests the socket server directly; this instead
 * spawns the real compiled binary as a child process against a live in-test server, so a
 * regression in the esbuild bundle, the JSON-RPC framing, or the CLI's argv handling shows up
 * here instead of requiring a human to smoke-test `pine whoami` by hand.
 */
import { execSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
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

// Tests are always run from the repo root (`npm test` / `npx vitest run ...`), so this is a
// reliable anchor without relying on `__dirname` (which vite-node doesn't reliably shim).
const repoRoot = process.cwd()
const cliPath = join(repoRoot, 'out', 'cli', 'index.js')

// Distinct-per-test socket path: pid + a monotonic counter (no Date.now()/random — mirrors
// the pattern in src/main/controlServer.test.ts).
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

/** Build a full env object, applying overrides (a `key: undefined` override deletes the key). */
function withEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key]
    else merged[key] = value
  }
  return merged
}

// Tracks children still alive so a hung/leaked process can't survive the suite.
const liveChildren = new Set<ReturnType<typeof spawn>>()

/** Spawn the real built CLI binary and collect its stdout/stderr/exit code. Kills on timeout. */
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
    if (!existsSync(cliPath)) {
      execSync('npm run build:cli', { cwd: repoRoot, stdio: 'ignore' })
    }
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
    // Belt-and-suspenders: runPine always waits for 'close' before settling, but make sure
    // nothing lingers if a test failed mid-flight.
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

    // controlServer's command.exec resolves { ok: false, error: { code: 'unknown-command' } }
    // for an id no descriptor matches; the CLI prints that error and exits non-zero.
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
})
