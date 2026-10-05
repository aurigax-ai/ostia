import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { programPath } from '../systemRequirements'
import { type KeptHostMeta, type KeptMeta, KeptShells, SANDBOX_HOST_KIND } from './keptShells'
import type { TmuxPane, TmuxServerOptions } from './tmuxServer'

const tmux = programPath('tmux') ?? 'tmux'
const root = mkdtempSync(join(tmpdir(), 'ostia-kept-'))
const live: KeptShells[] = []
let names = 0

afterEach(async () => {
  for (const kept of live.splice(0)) await kept.quit()
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

function instance(name: string): { kept: KeptShells; log: [string, Record<string, unknown>][] } {
  const log: [string, Record<string, unknown>][] = []
  const options: TmuxServerOptions = {
    tmux,
    dir: join(root, 'sock'),
    name,
    defaultTerminal: 'screen-256color',
    env: process.env,
  }
  const kept = new KeptShells({ options: () => options, log: (e, f) => log.push([e, f]) })
  live.push(kept)
  return { kept, log }
}

function meta(paneId: string): KeptMeta {
  return {
    paneId,
    externalId: `ext-${paneId}`,
    token: `token-${paneId}`,
    workspaceId: 'w1',
    shell: '/bin/sh',
    stateFile: '',
    spawnPath: process.env.PATH ?? '',
  }
}

function spawn(kept: KeptShells, paneId: string): Promise<TmuxPane> {
  return kept.spawn({
    file: '/bin/sh',
    args: ['-c', 'sleep 60'],
    cwd: root,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    cols: 80,
    rows: 24,
    meta: meta(paneId),
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function restart(name: string, saved: ReadonlySet<string> | null, keep = true) {
  const next = instance(name)
  await next.kept.start(keep, saved)
  return next
}

describe('KeptShells', () => {
  it('KSH-C15 ends a kept shell the restored layout does not name and logs it', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const named = await spawn(first.kept, 'p1')
    const unnamed = await spawn(first.kept, 'p2')
    first.kept.release()
    const second = await restart(name, new Set(['p1']))
    expect(second.kept.isWaiting('p1')).toBe(true)
    expect(second.kept.isWaiting('p2')).toBe(false)
    expect(second.log).toContainEqual(['pty-reap', { pane: 'p2', reason: 'unclaimed' }])
    expect(alive(named.pid)).toBe(true)
    await expect.poll(() => alive(unnamed.pid)).toBe(false)
  })

  it('KSH-C16 ends every kept shell when the saved layout cannot be read', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const pane = await spawn(first.kept, 'p1')
    first.kept.release()
    const second = await restart(name, null)
    expect(second.kept.isWaiting('p1')).toBe(false)
    await expect.poll(() => alive(pane.pid)).toBe(false)
  })

  it('KSH-C10 ends shells left behind by a quit that was cut off', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const pane = await spawn(first.kept, 'p1')
    first.kept.release()
    const second = await restart(name, new Set())
    expect(second.log).toContainEqual(['pty-reap', { pane: 'p1', reason: 'unclaimed' }])
    await expect.poll(() => alive(pane.pid)).toBe(false)
  })

  it('KSH-C22 ends kept shells when Ostia starts with the setting off', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const pane = await spawn(first.kept, 'p1')
    first.kept.release()
    const second = await restart(name, new Set(['p1']), false)
    expect(second.kept.isWaiting('p1')).toBe(false)
    await expect.poll(() => alive(pane.pid)).toBe(false)
  })

  it('KSH-C9 ends every shell and the server on quit, attached or not', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const pane = await spawn(first.kept, 'p1')
    first.kept.release()
    const second = await restart(name, new Set(['p1']))
    const other = await spawn(second.kept, 'p2')
    await second.kept.quit()
    await expect.poll(() => alive(pane.pid)).toBe(false)
    await expect.poll(() => alive(other.pid)).toBe(false)
    const third = await restart(name, new Set(['p1', 'p2']))
    expect(third.kept.isWaiting('p1')).toBe(false)
  })

  it('hands a kept shell back once, with its identity', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const pane = await spawn(first.kept, 'p1')
    first.kept.release()
    const second = await restart(name, new Set(['p1']))
    const claimed = second.kept.claim('p1')
    expect(claimed?.pane.pid).toBe(pane.pid)
    expect(claimed?.meta.token).toBe('token-p1')
    expect(second.kept.claim('p1')).toBeNull()
  })

  function sandboxed(kept: KeptShells, paneId: string): Promise<TmuxPane> {
    return kept.spawn({
      file: '/bin/sh',
      args: ['-c', 'sleep 60'],
      cwd: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      cols: 80,
      rows: 24,
      meta: { ...meta(paneId), sandbox: { stamp: 's1', bridgeId: 'b1', resizePipe: null } },
    })
  }

  function host(kept: KeptShells, workspaceId = 'w1'): Promise<TmuxPane> {
    const hostMeta: KeptHostMeta = {
      kind: SANDBOX_HOST_KIND,
      workspaceId,
      channel: join(root, `${workspaceId}.sock`),
      tmpDir: join(root, workspaceId),
      exposed: [3000],
    }
    return kept.spawnHost({
      file: '/bin/sh',
      args: ['-c', 'sleep 60'],
      cwd: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      meta: hostMeta,
    })
  }

  it('keeps a sandbox host while a kept pane of its workspace waits, with what it exposed', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const hostPane = await host(first.kept)
    await sandboxed(first.kept, 'p1')
    first.kept.release()
    const second = await restart(name, new Set(['p1']))
    expect(second.kept.isWaiting('p1')).toBe(true)
    expect(second.kept.keptHost('w1')?.exposed).toEqual([3000])
    expect(second.kept.claimHost('w1')?.pane.pid).toBe(hostPane.pid)
  })

  it('ends a sandbox host whose workspace keeps no pane', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const hostPane = await host(first.kept)
    await sandboxed(first.kept, 'p1')
    first.kept.release()
    const second = await restart(name, new Set())
    expect(second.kept.keptHost('w1')).toBeUndefined()
    await expect.poll(() => alive(hostPane.pid)).toBe(false)
  })

  it('KSH-C52 ends a sandboxed shell whose sandbox host died while Ostia was away and marks it lost', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const hostPane = await host(first.kept)
    const pane = await sandboxed(first.kept, 'p1')
    first.kept.release()
    process.kill(hostPane.pid, 'SIGKILL')
    await expect.poll(() => alive(hostPane.pid)).toBe(false)
    const second = await restart(name, new Set(['p1']))
    expect(second.kept.isWaiting('p1')).toBe(false)
    expect(second.log).toContainEqual(['pty-reap', { pane: 'p1', reason: 'sandbox-gone' }])
    await expect.poll(() => alive(pane.pid)).toBe(false)
    expect(second.kept.takeSandboxLost('p1')).toBe(true)
    expect(second.kept.takeSandboxLost('p1')).toBe(false)
  })
})
