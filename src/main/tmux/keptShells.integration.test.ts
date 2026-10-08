import { execFileSync, spawn as spawnChild } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { running, skipWithoutTmux, tmuxPath } from '../../../test/tmux'
import { HOST_PROTOCOL_VERSION } from '../sandbox/protocol'
import { type KeptHostMeta, type KeptMeta, KeptShells, SANDBOX_HOST_KIND } from './keptShells'
import type { TmuxPane } from './tmuxServer'

const tmux = tmuxPath ?? 'tmux'
const root = mkdtempSync(join(tmpdir(), 'ostia-kept-'))
const live: KeptShells[] = []
let names = 0
const PROCESS_END_MS = 10_000

afterEach(async () => {
  for (const kept of live.splice(0)) await kept.quit()
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

function instance(name: string): { kept: KeptShells; log: [string, Record<string, unknown>][] } {
  const log: [string, Record<string, unknown>][] = []
  const kept = new KeptShells({
    dir: join(root, 'sock'),
    name,
    program: () => ({ tmux, defaultTerminal: 'screen-256color', env: process.env }),
    log: (e, f) => log.push([e, f]),
  })
  live.push(kept)
  return { kept, log }
}

function meta(paneId: string): KeptMeta {
  return {
    paneId,
    externalId: `ext-${paneId}`,
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

async function ended(pid: number): Promise<void> {
  await expect.poll(() => running(pid), { timeout: PROCESS_END_MS }).toBe(false)
}

async function restart(name: string, saved: ReadonlySet<string> | null, keep = true) {
  const next = instance(name)
  await next.kept.start(keep, saved)
  return next
}

describe.skipIf(skipWithoutTmux)('KeptShells', () => {
  it('counts a shell that exited but was not reaped yet as ended, as tmux 3.4 leaves one whose SIGCHLD it lost', async () => {
    const parent = spawnChild('/bin/sh', ['-c', 'sleep 0.1 & echo $!; exec sleep 5'])
    const pid = await new Promise<number>((resolve) =>
      parent.stdout.once('data', (d: Buffer) => resolve(Number(d.toString('utf8').trim()))),
    )
    await ended(pid)
    expect(() => process.kill(pid, 0)).not.toThrow()
    parent.kill()
  })

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
    expect(running(named.pid)).toBe(true)
    await ended(unnamed.pid)
  })

  it('KSH-C16 ends every kept shell when the saved layout cannot be read', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const pane = await spawn(first.kept, 'p1')
    first.kept.release()
    const second = await restart(name, null)
    expect(second.kept.isWaiting('p1')).toBe(false)
    await ended(pane.pid)
  })

  it('KSH-C10 ends shells left behind by a quit that was cut off', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const pane = await spawn(first.kept, 'p1')
    first.kept.release()
    const second = await restart(name, new Set())
    expect(second.log).toContainEqual(['pty-reap', { pane: 'p1', reason: 'unclaimed' }])
    await ended(pane.pid)
  })

  it('KSH-C22 ends kept shells when Ostia starts with the setting off', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const pane = await spawn(first.kept, 'p1')
    first.kept.release()
    const second = await restart(name, new Set(['p1']), false)
    expect(second.kept.isWaiting('p1')).toBe(false)
    await ended(pane.pid)
  })

  it('KSH-C9 ends every shell and the server on quit, attached or not', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const pane = await spawn(first.kept, 'p1')
    first.kept.release()
    const second = await restart(name, new Set(['p1']))
    const other = await spawn(second.kept, 'p2')
    await second.kept.quit()
    await ended(pane.pid)
    await ended(other.pid)
    const third = await restart(name, new Set(['p1', 'p2']))
    expect(third.kept.isWaiting('p1')).toBe(false)
  })

  it('KSH-C74 keeps a kept pane token out of tmux, and removes the token files of shells it ends', async () => {
    const name = `k${names++}`
    const first = instance(name)
    await spawn(first.kept, 'p1')
    await spawn(first.kept, 'p2')
    const tokens = ['p1', 'p2'].map((paneId) => `secret-${paneId}-${randomUUID()}`)
    const files = ['p1', 'p2'].map((paneId, i) => first.kept.writeToken(paneId, tokens[i]))
    first.kept.saveAttention('p1', { state: 'waiting', message: 'Run it?' })
    first.kept.saveAttention('p2', { state: 'done' })
    expect(statSync(first.kept.attentionFile('p1')).mode & 0o777).toBe(0o600)
    first.kept.release()
    const second = await restart(name, new Set(['p1']))
    expect(second.kept.savedAttention('p1')).toEqual({ state: 'waiting', message: 'Run it?' })
    expect(existsSync(second.kept.attentionFile('p2'))).toBe(false)
    const socket = join(root, 'sock', name)
    const dump = execFileSync(tmux, ['-S', socket, 'list-windows', '-a', '-F', '#{@ostia-meta}'], {
      encoding: 'utf8',
    })
      .split('\n')
      .map((line) => Buffer.from(line, 'base64').toString('utf8'))
      .join('\n')
    for (const token of tokens) expect(dump).not.toContain(token)
    expect(readFileSync(files[0], 'utf8')).toBe(tokens[0])
    expect(existsSync(files[1])).toBe(false)
    await second.kept.quit()
    expect(existsSync(files[0])).toBe(false)
    expect(existsSync(second.kept.attentionFile('p1'))).toBe(false)
  })

  it('removes a socket no server answers on without running tmux', async () => {
    const name = `k${names++}`
    const dir = join(root, 'sock')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stale = join(dir, name)
    const holder = spawnChild(process.execPath, [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(stale)}, () => console.log('up'))`,
    ])
    await new Promise((resolve) => holder.stdout.once('data', resolve))
    holder.kill('SIGKILL')
    await new Promise((resolve) => holder.once('exit', resolve))
    expect(existsSync(stale)).toBe(true)
    let asked = 0
    const kept = new KeptShells({
      dir,
      name,
      program: () => {
        asked += 1
        return { tmux, defaultTerminal: 'screen-256color', env: process.env }
      },
      log: () => undefined,
    })
    await kept.start(false, new Set())
    expect(existsSync(stale)).toBe(false)
    expect(asked).toBe(0)
  })

  it('hands a kept shell back once, with its identity', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const pane = await spawn(first.kept, 'p1')
    first.kept.release()
    const second = await restart(name, new Set(['p1']))
    const claimed = second.kept.claim('p1')
    expect(claimed?.pane.pid).toBe(pane.pid)
    expect(claimed?.meta.externalId).toBe('ext-p1')
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

  function host(
    kept: KeptShells,
    workspaceId = 'w1',
    protocol = HOST_PROTOCOL_VERSION,
  ): Promise<TmuxPane> {
    const hostMeta: KeptHostMeta = {
      kind: SANDBOX_HOST_KIND,
      workspaceId,
      channel: join(root, `${workspaceId}.sock`),
      tmpDir: join(root, workspaceId),
      protocol,
      exposed: [{ port: 3000, process: 'node', pid: 41 }],
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
    expect(second.kept.keptHost('w1')?.exposed).toEqual([{ port: 3000, process: 'node', pid: 41 }])
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
    await ended(hostPane.pid)
  })

  it('KSH-C52 ends a sandboxed shell whose sandbox host died while Ostia was away and marks it lost', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const hostPane = await host(first.kept)
    const pane = await sandboxed(first.kept, 'p1')
    first.kept.release()
    process.kill(hostPane.pid, 'SIGKILL')
    await ended(hostPane.pid)
    const second = await restart(name, new Set(['p1']))
    expect(second.kept.isWaiting('p1')).toBe(false)
    expect(second.log).toContainEqual(['pty-reap', { pane: 'p1', reason: 'sandbox-gone' }])
    await ended(pane.pid)
    expect(second.kept.takeSandboxLost('p1')).toBe(true)
    expect(second.kept.takeSandboxLost('p1')).toBe(false)
  })

  it('KSH-C75 ends the sandbox host of another protocol version and the shells that use it, and marks them lost', async () => {
    const name = `k${names++}`
    const first = instance(name)
    const hostPane = await host(first.kept, 'w1', HOST_PROTOCOL_VERSION + 1)
    const pane = await sandboxed(first.kept, 'p1')
    first.kept.release()
    const second = await restart(name, new Set(['p1']))
    expect(second.kept.isWaiting('p1')).toBe(false)
    expect(second.kept.keptHost('w1')).toBeUndefined()
    expect(second.log).toContainEqual([
      'sandbox-host-reap',
      { workspace: 'w1', reason: 'protocol' },
    ])
    expect(second.log).toContainEqual(['pty-reap', { pane: 'p1', reason: 'sandbox-gone' }])
    expect(second.kept.takeSandboxLost('p1')).toBe(true)
    await ended(hostPane.pid)
    await ended(pane.pid)
  })

  it('KSH-C60 never writes an injected secret into a tmux option, environment or the config', async () => {
    const name = `k${names++}`
    const { kept } = instance(name)
    const secret = `kept-value-${randomUUID()}`
    await kept.spawn({
      file: '/bin/sh',
      args: ['-c', 'sleep 60'],
      cwd: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', OSTIA_TEST_SECRET: secret },
      cols: 80,
      rows: 24,
      meta: { ...meta('p1'), sandbox: { stamp: 's1', bridgeId: 'b1', resizePipe: null } },
    })
    const socket = join(root, 'sock', name)
    const dump = (args: string[]) =>
      execFileSync(tmux, ['-S', socket, ...args], { encoding: 'utf8' })
    const seen = [
      dump(['show-options', '-g']),
      dump(['show-options', '-s']),
      dump(['show-options', '-w', '-g']),
      dump(['list-windows', '-a', '-F', '#{window_id}'])
        .trim()
        .split('\n')
        .map((id) => {
          const meta = dump(['show-options', '-wqv', '-t', id, '@ostia-meta']).trim()
          return `${dump(['show-options', '-w', '-t', id])}\n${Buffer.from(meta, 'base64').toString('utf8')}`
        })
        .join('\n'),
      dump(['show-environment', '-g']),
      dump(['show-environment', '-t', 'ostia']),
      readFileSync(join(root, 'sock', `${name}.conf`), 'utf8'),
    ].join('\n')
    expect(seen).not.toContain(secret)
  })
})
