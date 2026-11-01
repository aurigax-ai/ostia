import { type ChildProcessWithoutNullStreams, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  RemoteMailRequest,
  RemoteMailResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/remoteMail'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type RemoteHost, remoteHost } from '../../../../test/fixtures/ssh/remoteHost'
import { skipWithoutTmux } from '../../../../test/tmux'
import {
  NODE_CLI,
  NODE_ENTRY,
  NODE_SOCKET,
  NODE_TMUX_SOCKET,
  NODE_TOKENS,
} from '../../../shared/remote/remoteNode'
import { parseRemoteRef } from '../../../shared/remote/remoteRef'
import { planConnect } from '../plan'
import { nodeBundle } from './bundle'
import { HostLink } from './link'
import { RunnerClient } from './runnerClient'

const ASSETS = resolve(__dirname, '../../../../out/extensions/ssh/assets/node')
const POLL = { timeout: 20_000, interval: 50 }
const FAST = {
  heartbeatMs: 200,
  deadMs: 3000,
  pollMs: 100,
  backoffMinMs: 50,
  backoffMaxMs: 200,
  wakeGapMs: 600_000,
}

class FakeCore {
  readonly queue = new Map<
    string,
    { id: string; from: string; to: string; text: string; ts: string }
  >()
  readonly delivered = new Set<string>()
  readonly inbox: { id: string; from: string; to: string; text: string }[] = []
  readonly links: boolean[] = []
  readonly refused = new Map<string, string>()
  private readonly seen = new Set<string>()

  constructor(private readonly contact: string) {}

  send(id: string, to: string, text: string): void {
    this.queue.set(id, { id, from: this.contact, to, text, ts: '' })
  }

  handle = async (request: RemoteMailRequest): Promise<RemoteMailResult> => {
    if (request.op === 'out') return { ok: true, out: [...this.queue.values()] }
    if (request.op === 'stored') {
      this.queue.delete(request.id)
      this.delivered.add(request.id)
      return { ok: true }
    }
    if (request.op === 'refused') {
      this.refused.set(request.id, request.reason)
      this.queue.delete(request.id)
      return { ok: true }
    }
    if (request.op === 'link') {
      this.links.push(request.online)
      return { ok: true }
    }
    if (request.op === 'in') {
      if (request.mail.to !== this.contact) return { ok: false, error: 'not-allowed' }
      const key = `${request.host}:${request.mail.id}`
      if (!this.seen.has(key)) {
        this.seen.add(key)
        this.inbox.push({
          id: key,
          from: `remote:${request.host}:${request.mail.pane}`,
          to: request.mail.to,
          text: request.mail.text,
        })
      }
      return { ok: true }
    }
    return { ok: false, error: 'bad-op' }
  }
}

describe.skipIf(skipWithoutTmux)('the link between the desktop and a remote runner', () => {
  let host: RemoteHost
  let client: RunnerClient
  let link: HostLink
  let core: FakeCore
  const children: ChildProcessWithoutNullStreams[] = []
  let alpha = ''
  let beta = ''

  const cli = (pane: string, ...args: string[]): string => {
    const ran = spawnSync(process.execPath, [join(ASSETS, NODE_CLI), ...args], {
      encoding: 'utf8',
      env: {
        HOME: host.home,
        PATH: process.env.PATH,
        OSTIA_SOCKET: join(host.home, NODE_SOCKET),
        OSTIA_TOKEN_FILE: join(host.home, NODE_TOKENS, pane),
      },
    })
    return `${ran.stdout}${ran.stderr}`
  }

  beforeAll(async () => {
    host = remoteHost()
    const bundle = nodeBundle(
      [NODE_ENTRY, NODE_CLI].map((name) => ({ name, data: readFileSync(join(ASSETS, name)) })),
    )
    const plan = planConnect(['fakehost'])
    if (!plan) throw new Error('no plan')
    const opts = { spawn: host.spawn, requestTimeoutMs: 30_000, helloTimeoutMs: 30_000 }
    client = new RunnerClient(plan, bundle, opts)
    await client.install()
    await client.ensure()
    alpha = await client.paneNew({ agent: 'shell', folder: host.home, name: 'alpha' })
    beta = await client.paneNew({ agent: 'shell', folder: host.home, name: 'beta' })
    core = new FakeCore('local1')
    link = new HostLink({
      host: 'fakehost',
      plan,
      bundle,
      spawn: (argv) => {
        const child = host.spawn(argv)
        children.push(child)
        return child
      },
      remoteMail: core.handle,
      forwards: {
        onLink: async () => {},
        onPorts: async () => {},
        list: () => ({ ok: true, forwards: [] }),
        forward: async () => ({ ok: true, forwards: [] }),
        stop: async () => ({ ok: true, forwards: [] }),
      } as never,
      onState: () => {},
      times: FAST,
    })
    link.start()
    await vi.waitUntil(() => core.links.includes(true), POLL)
  })

  afterAll(() => {
    link.stop()
    spawnSync('tmux', ['-S', join(host.home, NODE_TMUX_SOCKET), 'kill-server'])
    host.cleanup()
  })

  function dropLink(): void {
    for (const child of children.splice(0)) child.kill('SIGKILL')
  }

  it('REM-L1 carries mail from the desktop to a remote pane and back, once each', async () => {
    core.send('d1', `remote:fakehost:${alpha}`, 'hello alpha')
    await expect.poll(() => core.delivered.has('d1'), POLL).toBe(true)
    expect(cli(alpha, 'bus', 'inbox')).toContain('hello alpha')
    expect(cli(alpha, 'bus', 'inbox')).toContain('from="desktop:local1"')
    cli(alpha, 'bus', 'send', 'desktop:local1', 'hello desktop')
    await expect.poll(() => core.inbox.length, POLL).toBe(1)
    expect(core.inbox[0]).toMatchObject({
      from: `remote:fakehost:${alpha}`,
      to: 'local1',
      text: 'hello desktop',
    })
  })

  it('REM-L2 loses and duplicates nothing when the link drops in the middle of sending both ways', async () => {
    const before = core.inbox.length
    for (let i = 0; i < 6; i++) {
      core.send(`x${i}`, `remote:fakehost:${beta}`, `to-beta-${i}`)
      cli(beta, 'bus', 'send', 'desktop:local1', `to-desktop-${i}`)
      if (i === 1 || i === 3) dropLink()
    }
    await expect
      .poll(() => [0, 1, 2, 3, 4, 5].every((i) => core.delivered.has(`x${i}`)), POLL)
      .toBe(true)
    await expect.poll(() => core.inbox.length, POLL).toBe(before + 6)
    const texts = core.inbox.slice(before).map((mail) => mail.text)
    expect(new Set(texts).size).toBe(6)
    const inbox = cli(beta, 'bus', 'inbox')
    for (let i = 0; i < 6; i++) {
      expect(inbox.match(new RegExp(`to-beta-${i}\\b`, 'g'))).toHaveLength(1)
    }
  })

  it('REM-L3 fails mail for a remote pane that does not exist, with the reason the host gave', async () => {
    core.send('bad1', 'remote:fakehost:deadbeef', 'nobody')
    await expect.poll(() => core.refused.get('bad1'), POLL).toBe('unknown-pane')
  })

  it('REM-L4 gives a remote process with no pane token no way to write mail as a pane or to the desktop', async () => {
    const paths = { socket: join(host.home, NODE_SOCKET) }
    const attempt = spawnSync(
      process.execPath,
      [
        '-e',
        `const net=require('net');const s=net.connect(${JSON.stringify(paths.socket)},()=>{const b=JSON.stringify({jsonrpc:'2.0',id:1,method:'bus.send',params:{to:'desktop:local1',text:'forged',from:'${alpha}'}});s.write('Content-Length: '+Buffer.byteLength(b)+'\\r\\n\\r\\n'+b)});let o='';s.on('data',d=>{o+=String(d)});setTimeout(()=>{console.log(o);process.exit(0)},1000)`,
      ],
      { encoding: 'utf8', env: { HOME: host.home, PATH: process.env.PATH } },
    )
    expect(attempt.stdout).toContain('Unhandled method')
    const selftest = await client.selftest()
    expect(selftest).toBe(true)
    await new Promise((r) => setTimeout(r, 500))
    expect(core.inbox.some((mail) => mail.text === 'forged')).toBe(false)
    expect(core.inbox.every((mail) => parseRemoteRef(mail.from) !== null)).toBe(true)
  })

  it('REM-L5 tells each remote pane once per outage and once when the link is back', async () => {
    const countOf = (needle: RegExp): number =>
      (cli(alpha, 'bus', 'inbox').match(needle) ?? []).length
    const offlines = countOf(/desktop is offline since/g)
    dropLink()
    await expect.poll(() => countOf(/desktop is offline since/g), POLL).toBe(offlines + 1)
    await expect
      .poll(() => countOf(/desktop is back; \d+ messages? delivered/g), POLL)
      .toBeGreaterThan(0)
    expect(countOf(/desktop is offline since/g)).toBe(offlines + 1)
  })
})
