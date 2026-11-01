import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type IPty, spawn as spawnPty } from 'node-pty'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FAKE_SSH_DIR, type RemoteHost, remoteHost } from '../../../../test/fixtures/ssh/remoteHost'
import { skipWithoutTmux } from '../../../../test/tmux'
import { NODE_TMUX_SOCKET } from '../../../shared/remote/remoteNode'
import { type ConnectPlan, planConnect, planControlForward, planRemote } from '../plan'
import { exitMasters, prepareControlDir, useControlDir } from '../share'
import { attachArgv } from './attach'

const POLL = { timeout: 10_000, interval: 50 }

describe.skipIf(skipWithoutTmux)('one ssh master per host over a fake ssh host', () => {
  let host: RemoteHost
  let dir: string
  let plan: ConnectPlan
  const ptys: IPty[] = []

  function attach(pane: string): IPty {
    const [file, ...args] = attachArgv(plan, pane, { disconnected: 'lost', failed: 'never' })
    const pty = spawnPty(file, args, {
      cols: 100,
      rows: 30,
      env: {
        ...host.env,
        TERM: 'xterm-256color',
        PATH: `${join(FAKE_SSH_DIR, 'bin')}:${process.env.PATH}`,
      } as Record<string, string>,
    })
    ptys.push(pty)
    return pty
  }

  function sockets(): string[] {
    return execFileSync('ls', [dir], { encoding: 'utf8' })
      .split('\n')
      .filter((name) => name && !name.includes('.'))
  }

  beforeAll(() => {
    host = remoteHost()
    dir = mkdtempSync('/tmp/oc-')
    useControlDir(prepareControlDir(dir, process.getuid?.()))
    const planned = planConnect(['fakehost'])
    if (!planned) throw new Error('no plan')
    plan = planned
    mkdirSync(dirname(join(host.home, NODE_TMUX_SOCKET)), { recursive: true })
    execFileSync('tmux', [
      '-S',
      join(host.home, NODE_TMUX_SOCKET),
      'new-session',
      '-d',
      '-s',
      '0123abcd',
      'sh',
    ])
  })

  afterAll(() => {
    useControlDir(null)
    for (const pty of ptys) pty.kill()
    spawnSync('tmux', ['-S', join(host.home, NODE_TMUX_SOCKET), 'kill-server'], {
      stdio: 'ignore',
    })
    host.cleanup()
    rmSync(dir, { recursive: true, force: true })
  })

  async function run(command: string): Promise<void> {
    const child = host.spawn(planRemote(plan, command))
    await new Promise((resolve) => child.on('close', resolve))
  }

  it('SHR-C1 a tab, a runner command and a second tab on one host open one master and the others ride on it', async () => {
    const first = attach('0123abcd')
    first.write(`echo one > ${host.home}/one\r`)
    await expect.poll(() => existsSync(join(host.home, 'one')), POLL).toBe(true)
    await run('true')
    const second = attach('0123abcd')
    second.write(`echo two > ${host.home}/two\r`)
    await expect.poll(() => existsSync(join(host.home, 'two')), POLL).toBe(true)
    const muxLog = host.mux()
    expect(muxLog.filter((line) => line.includes('master:'))).toHaveLength(1)
    expect(muxLog.filter((line) => line.includes('mux client:'))).toHaveLength(2)
    expect(sockets()).toHaveLength(1)
  })

  it('SHR-C2 another host gets its own master', async () => {
    const other = planConnect(['otherhost'])
    if (!other) throw new Error('no plan')
    const child = host.spawn(planRemote(other, 'true'))
    await new Promise((resolve) => child.on('close', resolve))
    expect(sockets()).toHaveLength(2)
  })

  it('SHR-C3 a lost master is replaced by the next client without any retry', async () => {
    const before = host.mux().filter((line) => line.includes('master:')).length
    for (const socket of sockets()) rmSync(join(dir, socket))
    await run('true')
    expect(host.mux().filter((line) => line.includes('master:'))).toHaveLength(before + 1)
  })

  it('SHR-C8 adds and removes a forward on the live master with -O and opens no master of its own', async () => {
    await run('true')
    const masters = host.mux().filter((line) => line.includes('master:')).length
    const [socket] = readdirSync(dir).filter((name) => !name.includes('.'))
    const forwards = join(dir, `${socket}.forwards`)
    const spawnOp = async (op: 'forward' | 'cancel') => {
      const argv = planControlForward(plan, op, 3000, 4000)
      if (!argv) throw new Error('sharing off')
      const child = host.spawn(argv)
      return new Promise<number | null>((resolve) => child.on('close', resolve))
    }
    expect(await spawnOp('forward')).toBe(0)
    expect(readFileSync(forwards, 'utf8')).toContain('127.0.0.1:4000:127.0.0.1:3000')
    expect(await spawnOp('cancel')).toBe(0)
    expect(readFileSync(forwards, 'utf8')).not.toContain('4000')
    expect(host.mux().filter((line) => line.includes('master:'))).toHaveLength(masters)
  })

  it('SHR-C9 an -O command with no master fails and does not create one', async () => {
    rmSync(join(dir, readdirSync(dir).filter((name) => !name.includes('.'))[0]))
    const argv = planControlForward(plan, 'forward', 3000, 4000)
    if (!argv) throw new Error('sharing off')
    const child = host.spawn(argv)
    expect(await new Promise((resolve) => child.on('close', resolve))).toBe(255)
    expect(readdirSync(dir).filter((name) => !name.includes('.'))).toHaveLength(0)
    await run('true')
  })

  it('SHR-C4 quitting exits the masters in Ostia own folder and no other', async () => {
    const path = process.env.PATH
    process.env.FAKE_SSH_LOG = host.log
    process.env.PATH = `${join(FAKE_SSH_DIR, 'bin')}:${path}`
    exitMasters(dir)
    process.env.PATH = path
    delete process.env.FAKE_SSH_LOG
    expect(sockets()).toHaveLength(0)
    const exits = host.runs().filter((line) => line.includes('-O exit'))
    expect(exits.length).toBeGreaterThan(0)
    for (const line of exits) expect(line).toContain(`-S ${dir}/`)
  })
})
