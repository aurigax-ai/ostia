import { describe, expect, it, vi } from 'vitest'
import { en } from '../../shared/app/dict'
import { tmuxMissing } from './keepShellsBanner'
import { createKeptSpawner, tmuxMissingReason } from './keptSpawn'

const TMUX_MISSING = tmuxMissing(en.native.paneBanner)
const program = { tmux: '/usr/bin/tmux', defaultTerminal: 'screen-256color', env: {} }

describe('tmuxMissingReason', () => {
  it('KSH-C20 names tmux as missing when no program is found even after the login shell PATH', async () => {
    const settled = vi.fn(async () => undefined)
    expect(await tmuxMissingReason(() => null, settled, TMUX_MISSING)).toBe(TMUX_MISSING)
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('KSH-C91 waits for the login shell PATH and keeps the shell when tmux is found there', async () => {
    let found: typeof program | null = null
    const settled = async () => {
      found = program
    }
    expect(await tmuxMissingReason(() => found, settled, TMUX_MISSING)).toBe('')
  })

  it('does not wait for the login shell PATH when tmux is already found', async () => {
    const settled = vi.fn(async () => undefined)
    expect(await tmuxMissingReason(() => program, settled, TMUX_MISSING)).toBe('')
    expect(settled).not.toHaveBeenCalled()
  })
})

describe('spawnKept', () => {
  const plan = {
    identity: { externalId: 'x' },
    workspaceId: 'w1',
    shell: '/bin/sh',
    cols: 80,
    rows: 24,
    stateFile: '',
    markNonce: null,
    env: { PATH: '/bin' },
    sandboxStamp: null,
    resizePipe: null,
    portBridge: null,
    file: '/bin/sh',
    args: [],
    cwd: '/',
    sandboxed: false,
    notKept: '',
    agentDir: '/run/agents/older',
  }

  function spawner(spawn: () => Promise<unknown>) {
    const info = vi.fn()
    const { spawnKept } = createKeptSpawner({
      keptShells: { spawn } as never,
      keptPlumbing: { ensure: vi.fn() } as never,
      withKeptProcess: (meta) => meta,
      keptPaneEnv: (env) => env as Record<string, string>,
      appLog: () => ({ info }) as never,
    })
    return { spawnKept, info }
  }

  it('KSH-C65 starts no kept shell and gives what tmux printed as the reason when tmux cannot start its server', async () => {
    const { spawnKept, info } = spawner(async () => {
      throw new Error('tmux could not start its server: server refused')
    })
    const spawned = await spawnKept('p1', plan as never)
    expect(spawned.kept).toBeNull()
    expect(spawned.keptMeta).toBeNull()
    expect(spawned.notKept).toBe('tmux could not start its server: server refused')
    expect(info).toHaveBeenCalledWith('kept-spawn-failed', {
      pane: 'p1',
      reason: 'tmux could not start its server: server refused',
    })
  })

  it('returns the kept pane and no reason when tmux starts it', async () => {
    const pane = { pid: 1 }
    const { spawnKept } = spawner(async () => pane)
    const spawned = await spawnKept('p1', plan as never)
    expect(spawned.kept).toBe(pane)
    expect(spawned.keptMeta).toMatchObject({ paneId: 'p1', workspaceId: 'w1' })
    expect(spawned.notKept).toBe('')
  })

  it('records the agent generation the shell runs in, so a later build keeps it', async () => {
    const spawn = vi.fn(async () => ({ pid: 1 }))
    const { spawnKept } = spawner(spawn)
    const spawned = await spawnKept('p1', plan as never)
    expect(spawned.keptMeta?.agentDir).toBe('/run/agents/older')
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ agentDir: '/run/agents/older' }) }),
    )
  })
})
