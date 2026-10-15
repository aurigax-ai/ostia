import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { running } from '../../../test/tmux'
import { SandboxUnavailableError } from '../sandbox/workspaceSandboxes'
import { EXEC_CONCURRENT_MAX, type ExecDeps, ExtensionExec } from './extensionExec'

const POLL = { timeout: 6000, interval: 50 }

const FAKE_TOOL = resolve(__dirname, '../../../test/fixtures/tools/bin/fake-tool')

interface Space {
  workDir: string
  scratch?: boolean
  sandboxed?: boolean
  wrapFails?: boolean
}

function setup(spaces: Record<string, Space>) {
  const data = mkdtempSync(join(tmpdir(), 'exec-data-'))
  mkdirSync(join(data, 'graphs/runs/x/out'), { recursive: true })
  const wrapped: string[] = []
  const deps: ExecDeps = {
    workspace: (id) => spaces[id] ?? null,
    wrap: async (id, command) => {
      if (spaces[id]?.wrapFails) throw new SandboxUnavailableError('no bwrap')
      wrapped.push(command)
      return command
    },
    sandboxEnv: (_id, env) => env,
    dataDir: (extId) => join(data, extId),
    baseEnv: () => ({
      PATH: process.env.PATH ?? '',
      HOME: '/home/u',
      OSTIA_TOKEN: 'secret',
      OSTIA_SOCKET: '/s',
    }),
  }
  return { exec: new ExtensionExec(deps), data, wrapped }
}

const execs: ExtensionExec[] = []
afterEach(() => {
  for (const exec of execs.splice(0)) exec.stopAll()
})

function track(exec: ExtensionExec): ExtensionExec {
  execs.push(exec)
  return exec
}

function envLines(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
}

describe('ext.exec', () => {
  it('GRF-C110 runs an argv with no terminal, passes env and no OSTIA_ name but OSTIA_EXEC_DIR', async () => {
    const { exec } = setup({ w1: { workDir: tmpdir() } })
    track(exec)
    const plain = await exec.run('graphs', {
      workspaceId: 'w1',
      command: [FAKE_TOOL, 'env'],
      timeoutMs: 10_000,
      env: { GRAPH_RUN_ID: 'r1' },
    })
    expect(plain).toMatchObject({ ok: true, exitCode: 0, timedOut: false, sandboxed: false })
    const env = envLines((plain as { stdout: string }).stdout)
    expect(env.GRAPH_RUN_ID).toBe('r1')
    expect(Object.keys(env).filter((k) => k.startsWith('OSTIA_'))).toEqual([])

    const withDir = await exec.run('graphs', {
      workspaceId: 'w1',
      command: [FAKE_TOOL, 'env'],
      timeoutMs: 10_000,
      dataDir: 'runs/x/out',
    })
    const names = Object.keys(envLines((withDir as { stdout: string }).stdout))
    expect(names.filter((k) => k.startsWith('OSTIA_'))).toEqual(['OSTIA_EXEC_DIR'])
  })

  it('GRF-C112 refuses scratch, unknown workspaces, a failed wrap and bad params, spawning nothing', async () => {
    const { exec, data, wrapped } = setup({
      s: { workDir: tmpdir(), scratch: true },
      sb: { workDir: tmpdir(), sandboxed: true, wrapFails: true },
      w1: { workDir: tmpdir() },
    })
    track(exec)
    symlinkSync(join(data, 'graphs/runs'), join(data, 'graphs/linked'))
    const call = (params: Record<string, unknown>) =>
      exec.run('graphs', {
        workspaceId: 'w1',
        command: [FAKE_TOOL, 'env'],
        timeoutMs: 1000,
        ...params,
      })
    const error = async (params: Record<string, unknown>) =>
      ((await call(params)) as { error?: string }).error
    expect(await error({ workspaceId: 's' })).toBe('scratch')
    expect(await error({ workspaceId: 'nope' })).toBe('unknown-workspace')
    expect(await error({ workspaceId: 'sb' })).toBe('sandbox-unavailable')
    expect(await error({ dataDir: '../x' })).toBe('invalid-params')
    expect(await error({ dataDir: '/etc' })).toBe('invalid-params')
    expect(await error({ dataDir: 'linked' })).toBe('invalid-params')
    expect(await error({ command: [FAKE_TOOL, 'a\u0007b'] })).toBe('invalid-params')
    expect(await error({ env: { OSTIA_TOKEN: 'x' } })).toBe('invalid-params')
    expect(wrapped).toEqual([])
    expect(exec.active('graphs')).toBe(0)
  })

  it('GRF-C113 cancel, timeout and the extension exiting each end the process and its child; a ninth call is too-many', async () => {
    const { exec, data } = setup({ w1: { workDir: tmpdir() } })
    track(exec)
    const pids = async (file: string): Promise<number[]> => {
      await vi.waitUntil(() => {
        try {
          return readFileSync(file, 'utf8').includes(' ')
        } catch {
          return false
        }
      }, POLL)
      return readFileSync(file, 'utf8').trim().split(' ').map(Number)
    }
    const sleeper = (name: string, timeoutMs = 60_000, signal?: AbortSignal) =>
      exec.run(
        'graphs',
        { workspaceId: 'w1', command: [FAKE_TOOL, 'sleep-child', join(data, name)], timeoutMs },
        signal,
      )

    const abort = new AbortController()
    const cancelled = sleeper('a', 60_000, abort.signal)
    const a = await pids(join(data, 'a'))
    abort.abort()
    await cancelled
    await vi.waitUntil(() => a.every((pid) => !running(pid)), POLL)

    const timedOut = sleeper('b', 500)
    const b = await pids(join(data, 'b'))
    expect(await timedOut).toMatchObject({ ok: true, timedOut: true, exitCode: -1 })
    await vi.waitUntil(() => b.every((pid) => !running(pid)), POLL)

    const gone = sleeper('c')
    const c = await pids(join(data, 'c'))
    exec.stopFor('graphs')
    await gone
    await vi.waitUntil(() => c.every((pid) => !running(pid)), POLL)

    const many = Array.from({ length: EXEC_CONCURRENT_MAX }, (_, i) => sleeper(`m${i}`))
    expect(exec.active('graphs')).toBe(EXEC_CONCURRENT_MAX)
    expect(await sleeper('ninth')).toMatchObject({ ok: false, error: 'too-many' })
    exec.stopFor('graphs')
    await Promise.all(many)
  }, 40_000)

  it('refuses env names that change loading or the shell, and gives the command the app GPU env back', async () => {
    const { exec } = setup({ w1: { workDir: tmpdir() } })
    track(exec)
    for (const name of [
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'BASH_ENV',
      'ENV',
      'IFS',
      'PATH',
      'NODE_OPTIONS',
    ]) {
      const res = await exec.run('graphs', {
        workspaceId: 'w1',
        command: [FAKE_TOOL, 'env'],
        timeoutMs: 1000,
        env: { [name]: 'x' },
      })
      expect(res, name).toMatchObject({ ok: false, error: 'invalid-params' })
    }
    const gpu = new ExtensionExec({
      workspace: () => ({ workDir: tmpdir() }),
      wrap: async (_id, command) => command,
      sandboxEnv: (_id, env) => env,
      dataDir: () => tmpdir(),
      baseEnv: () => ({
        PATH: process.env.PATH ?? '',
        DRI_PRIME: '1',
        OSTIA_GPU_RESTORE: JSON.stringify({ DRI_PRIME: null }),
      }),
    })
    track(gpu)
    const res = await gpu.run('graphs', {
      workspaceId: 'w1',
      command: [FAKE_TOOL, 'env'],
      timeoutMs: 10_000,
    })
    expect(Object.keys(envLines((res as { stdout: string }).stdout))).not.toContain('DRI_PRIME')
  })
})
