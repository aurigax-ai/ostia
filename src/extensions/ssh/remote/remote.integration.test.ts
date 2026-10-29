import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type IPty, spawn as spawnPty } from 'node-pty'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FAKE_SSH_DIR, type RemoteHost, remoteHost } from '../../../../test/fixtures/ssh/remoteHost'
import { skipWithoutTmux } from '../../../../test/tmux'
import {
  NODE_AGENTS,
  NODE_CLI,
  NODE_ENTRY,
  NODE_SOCKET,
  NODE_TMUX_SOCKET,
  NODE_TOKENS,
} from '../../../shared/remote/remoteNode'
import { HelperFailure } from '../channel'
import { planConnect } from '../plan'
import { attachArgv } from './attach'
import { type NodeBundle, nodeBundle } from './bundle'
import { classify, RunnerClient } from './runnerClient'

const ASSETS = resolve(__dirname, '../../../../out/extensions/ssh/assets/node')
function nodePaths(home: string) {
  return {
    socket: join(home, NODE_SOCKET),
    tmuxSocket: join(home, NODE_TMUX_SOCKET),
    tokens: join(home, NODE_TOKENS),
    agents: join(home, NODE_AGENTS),
  }
}

const POLL = { timeout: 10_000, interval: 50 }

describe.skipIf(skipWithoutTmux)('remote runner over a fake ssh host', () => {
  let host: RemoteHost
  let bundle: NodeBundle
  let client: RunnerClient
  const ptys: IPty[] = []

  beforeAll(() => {
    const stubs = mkdtempSync(join(tmpdir(), 'ostia-remote-stubs-'))
    writeFileSync(
      join(stubs, 'claude'),
      '#!/bin/sh\n[ "$1" = auth ] && [ -f "$HOME/signed-in" ] && exit 0\n[ "$1" = auth ] && exit 1\necho "$@" >"$HOME/claude.args"\necho "$OSTIA_SOCKET" >"$HOME/claude.socket"\nexec sleep 300\n',
      { mode: 0o700 },
    )
    host = remoteHost({ path: `${stubs}:${process.env.PATH}` })
    bundle = nodeBundle(
      [NODE_ENTRY, NODE_CLI].map((name) => ({ name, data: readFileSync(join(ASSETS, name)) })),
    )
    const plan = planConnect(['fakehost'])
    if (!plan) throw new Error('no plan')
    client = new RunnerClient(plan, bundle, {
      spawn: host.spawn,
      requestTimeoutMs: 30_000,
      helloTimeoutMs: 30_000,
    })
  })

  afterAll(() => {
    for (const pty of ptys) pty.kill()
    const paths = nodePaths(host.home)
    spawnSync('tmux', ['-S', paths.tmuxSocket, 'kill-server'])
    host.cleanup()
  })

  function attach(pane: string): IPty {
    const plan = planConnect(['fakehost'])
    if (!plan) throw new Error('no plan')
    const [file, ...args] = attachArgv(plan, pane, {
      disconnected: 'Disconnected, reconnecting',
      failed: 'Not connected',
    })
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

  it('REM-C1 reports what the host has and that the runner is not installed yet', async () => {
    await client.reach()
    const probe = await client.probe()
    expect(probe.node).not.toBeNull()
    expect(probe.tmux).not.toBeNull()
    await expect(client.ensure()).rejects.toMatchObject({ code: 'missing' })
  })

  it('REM-C2 installs the bundle, starts the runner and answers the round trip', async () => {
    await client.install()
    expect((await client.ensure()).version).toBe(bundle.version)
    expect(await client.selftest()).toBe(true)
    expect((await client.ping()).version).toBe(bundle.version)
  })

  it('REM-C3 keeps a remote pane running after the ssh client is killed and a new tab reattaches', async () => {
    const pane = await client.paneNew({ agent: 'shell', folder: host.home, name: 'worker' })
    const first = attach(pane)
    first.write(`echo first > ${host.home}/first\r`)
    await expect.poll(() => existsSync(join(host.home, 'first')), POLL).toBe(true)
    first.kill('SIGKILL')
    const sessions = execFileSync(
      'tmux',
      ['-S', nodePaths(host.home).tmuxSocket, 'list-sessions', '-F', '#{session_name}'],
      { encoding: 'utf8' },
    )
    expect(sessions).toContain(pane)
    expect((await client.jobs()).map((job) => job.pane)).toContain(pane)
    const second = attach(pane)
    second.write(`echo second > ${host.home}/second\r`)
    await expect.poll(() => existsSync(join(host.home, 'second')), POLL).toBe(true)
  })

  it('REM-C4 mails between two remote panes with no link, through the real ostia CLI and hooks', async () => {
    const paths = nodePaths(host.home)
    const sender = await client.paneNew({ agent: 'shell', folder: host.home, name: 'sender' })
    const receiver = await client.paneNew({ agent: 'shell', folder: host.home, name: 'receiver' })
    const cli = (pane: string, ...args: string[]): string => {
      const ran = spawnSync(process.execPath, [join(ASSETS, NODE_CLI), ...args], {
        encoding: 'utf8',
        env: {
          HOME: host.home,
          PATH: process.env.PATH,
          OSTIA_SOCKET: paths.socket,
          OSTIA_TOKEN_FILE: join(paths.tokens, pane),
        },
      })
      return `${ran.stdout}${ran.stderr}`
    }
    expect(cli(sender, 'bus', 'send', 'receiver', 'hello from sender')).toContain('"queued"')
    expect(cli(receiver, 'bus', 'inbox')).toContain('hello from sender')
    const hook = cli(receiver, 'bus', 'hook', 'UserPromptSubmit')
    expect(hook).toContain('hello from sender')
    expect(cli(receiver, 'bus', 'inbox')).toContain('(no messages)')
  })

  it('REM-C8 starts claude with the plugin tree generated on the host and keeps it running', async () => {
    const pane = await client.paneNew({ agent: 'claude', folder: host.home })
    await expect.poll(() => existsSync(join(host.home, 'claude.args')), POLL).toBe(true)
    const args = readFileSync(join(host.home, 'claude.args'), 'utf8')
    const paths = nodePaths(host.home)
    expect(args).toMatch(/--plugin-dir \S+\/claude-plugin --plugin-dir \S+\/claude-fold/)
    expect(readFileSync(join(host.home, 'claude.socket'), 'utf8').trim()).toBe(paths.socket)
    expect(args).toContain(paths.agents)
    expect((await client.jobs()).find((job) => job.pane === pane)?.agent).toBe('claude')
    await client.stop(pane)
  })

  it('REM-C10 reports the agent as signed in only when its own status command passes', async () => {
    expect(await client.signedIn('claude')).toBe(false)
    writeFileSync(join(host.home, 'signed-in'), '')
    expect(await client.signedIn('claude')).toBe(true)
  })

  it('REM-C5 stops a job and removes it from the list', async () => {
    const [job] = await client.jobs()
    await client.stop(job.pane)
    expect((await client.jobs()).map((item) => item.pane)).not.toContain(job.pane)
  })

  function loopRun(stub: string): ReturnType<typeof spawnSync> {
    const fake = join(host.home, 'flaky')
    writeFileSync(fake, stub, { mode: 0o700 })
    const plan = planConnect(['fakehost'])
    if (!plan) throw new Error('no plan')
    const [file, ...args] = attachArgv(plan, '0123abcd', {
      disconnected: 'Disconnected, reconnecting',
      failed: 'Not connected',
    })
    return spawnSync(file, [...args.slice(0, 5), fake], { encoding: 'utf8', timeout: 40_000 })
  }

  it('REM-C6 the tab loop ends at once with a message when the first connect fails', () => {
    const ran = loopRun('#!/bin/sh\nexit 255\n')
    expect(ran.status).toBe(255)
    expect(String(ran.stdout)).toContain('Not connected')
    expect(String(ran.stdout)).not.toContain('Disconnected, reconnecting')
  })

  it('REM-C9 the tab loop retries a dropped link after it connected and ends when the session ends', () => {
    const counter = join(host.home, 'count')
    const ran = loopRun(
      `#!/bin/sh\nn=$(cat "${counter}" 2>/dev/null || echo 0)\necho $((n + 1)) >"${counter}"\n[ "$n" -eq 0 ] && { sleep 11; exit 255; }\nexit 0\n`,
    )
    expect(ran.status).toBe(0)
    expect(String(ran.stdout).match(/Disconnected, reconnecting/g)).toHaveLength(1)
  }, 40_000)

  it('REM-C7 sorts ssh failures into the setup card errors', () => {
    const failed = (detail: string) => classify(new HelperFailure('connect-failed', detail)).code
    expect(failed('Permission denied (publickey).')).toBe('auth')
    expect(failed('Host key verification failed.')).toBe('host-key')
    expect(failed('ssh: connect to host x port 22: Network is unreachable')).toBe('network')
  })
})
