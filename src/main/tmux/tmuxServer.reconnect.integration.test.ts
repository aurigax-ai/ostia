import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { running, skipWithoutTmux, tmuxPath } from '../../../test/tmux'
import type { KeptLink } from '../../shared/terminal/ptyApi'
import type { TmuxPane } from './tmuxPane'
import { TmuxServer } from './tmuxServer'

const tmux = tmuxPath ?? 'tmux'
const root = mkdtempSync(join(tmpdir(), 'ostia-tmux-reconnect-'))
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
const env = { ...process.env, HOME: home }
const servers: TmuxServer[] = []
let names = 0

afterEach(async () => {
  for (const server of servers.splice(0)) await server.killServer()
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

type Logged = { event: string; fields: Record<string, string> }

async function connect(
  program = tmux,
): Promise<{ server: TmuxServer; logs: Logged[]; sock: string }> {
  const logs: Logged[] = []
  const name = `r${names++}`
  const dir = join(root, 'sock')
  const server = await TmuxServer.connect(
    {
      tmux: program,
      dir,
      name,
      defaultTerminal: 'screen-256color',
      env,
      log: (event, fields) => logs.push({ event, fields }),
    },
    () => undefined,
  )
  servers.push(server)
  return { server, logs, sock: join(dir, name) }
}

function spawnSh(server: TmuxServer, script: string, id = 'p1'): Promise<TmuxPane> {
  return server.spawn({
    file: '/bin/sh',
    args: ['-c', script],
    cwd: root,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
    cols: 80,
    rows: 24,
    meta: { paneId: id },
  })
}

function watch(pane: TmuxPane): { text: () => string; exits: number[]; links: KeptLink[] } {
  let text = ''
  const exits: number[] = []
  const links: KeptLink[] = []
  pane.onData((d) => {
    text += d
  })
  pane.onExit(({ exitCode }) => exits.push(exitCode))
  pane.onLink((state) => links.push(state))
  return { text: () => text, exits, links }
}

function controlClientPids(sock: string): number[] {
  return execFileSync(tmux, ['-u', '-S', sock, 'list-clients', '-F', '#{client_pid}'], {
    encoding: 'utf8',
    env,
  })
    .split('\n')
    .filter(Boolean)
    .map(Number)
}

const POLL = { timeout: 8000, interval: 20 }
const TICKER = 'i=0; while :; do echo tick-$i; i=$((i+1)); sleep 0.1; done'

describe.skipIf(skipWithoutTmux)('TmuxServer reconnect', () => {
  it('KSH-C104 keeps a pane open and its output flowing when the control client dies', async () => {
    const { server, logs, sock } = await connect()
    const pane = await spawnSh(server, TICKER)
    const seen = watch(pane)
    await vi.waitUntil(() => seen.text().includes('tick-1'), POLL)
    const [pid] = controlClientPids(sock)
    process.kill(pid as number, 'SIGKILL')
    await vi.waitUntil(() => logs.some((l) => l.event === 'tmux-control-reconnected'), POLL)
    const after = seen.text().length
    await vi.waitUntil(() => seen.text().length > after + 20, POLL)
    expect(seen.exits).toEqual([])
    expect(pane.hasExited).toBe(false)
    expect(running(pane.pid)).toBe(true)
    expect(seen.links).toEqual(['reconnecting', 'up'])
    const ended = logs.find((l) => l.event === 'tmux-control-ended')
    expect(ended?.fields).toMatchObject({ signal: 'SIGKILL', cause: 'lost' })
  })

  it('KSH-C105 logs the %exit reason tmux gives and reconnects once tmux answers again', async () => {
    const fake = join(root, `flaky-tmux-${names}`)
    const failing = join(root, `fail-${names}`)
    writeFileSync(
      fake,
      `#!/bin/sh\nif [ -e "${failing}" ]; then case "$*" in *" -C "*) echo "%exit too far behind"; exit 0;; esac; fi\nexec "${tmux}" "$@"\n`,
      { mode: 0o755 },
    )
    const { server, logs, sock } = await connect(fake)
    const pane = await spawnSh(server, TICKER)
    const seen = watch(pane)
    await vi.waitUntil(() => seen.text().includes('tick-1'), POLL)
    writeFileSync(failing, '')
    const [pid] = controlClientPids(sock)
    process.kill(pid as number, 'SIGKILL')
    await vi.waitUntil(() => logs.some((l) => l.fields.reason === 'too far behind'), POLL)
    expect(seen.links).toContain('reconnecting')
    rmSync(failing)
    await vi.waitUntil(() => logs.some((l) => l.event === 'tmux-control-reconnected'), POLL)
    const after = seen.text().length
    await vi.waitUntil(() => seen.text().length > after + 20, POLL)
    expect(seen.exits).toEqual([])
    expect(existsSync(failing)).toBe(false)
  })

  it('KSH-C106 redraws the screen of a pane that kept running while the client was away', async () => {
    const { server, logs, sock } = await connect()
    const pane = await spawnSh(server, 'echo before-gap; sleep 1; echo during-gap; sleep 30')
    const seen = watch(pane)
    await vi.waitUntil(() => seen.text().includes('before-gap'), POLL)
    server.suspend()
    await vi.waitUntil(() => controlClientPids(sock).length === 0, POLL)
    await new Promise((resolve) => setTimeout(resolve, 1300))
    expect(seen.text()).not.toContain('during-gap')
    server.resume()
    await vi.waitUntil(() => seen.text().includes('during-gap'), POLL)
    expect(seen.exits).toEqual([])
    expect(logs.find((l) => l.event === 'tmux-control-ended')?.fields.cause).toBe('suspend')
    expect(logs.some((l) => l.event === 'tmux-control-reconnected')).toBe(true)
  })

  it('KSH-C107 reports the real exit status of a window that ended while the client was away', async () => {
    const { server, sock } = await connect()
    const pane = await spawnSh(server, 'sleep 1; exit 7')
    const gone = await spawnSh(server, 'sleep 30', 'p2')
    const seen = watch(pane)
    const alive = watch(gone)
    server.suspend()
    await vi.waitUntil(() => controlClientPids(sock).length === 0, POLL)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    server.resume()
    await vi.waitUntil(() => seen.exits.length > 0, POLL)
    expect(seen.exits).toEqual([7])
    expect(alive.exits).toEqual([])
  })

  it('KSH-C108 offers a retry, and kills nothing, when tmux does not answer the reconnect', async () => {
    const fake = join(root, `silent-tmux-${names}`)
    const silent = join(root, `silent-${names}`)
    writeFileSync(
      fake,
      `#!/bin/sh\nif [ -e "${silent}" ]; then case "$*" in *" -C "*) sleep 60; exit 0;; esac; fi\nexec "${tmux}" "$@"\n`,
      { mode: 0o755 },
    )
    const { server, logs, sock } = await connect(fake)
    const pane = await spawnSh(server, TICKER)
    const seen = watch(pane)
    await vi.waitUntil(() => seen.text().includes('tick-1'), POLL)
    writeFileSync(silent, '')
    const [pid] = controlClientPids(sock)
    process.kill(pid as number, 'SIGKILL')
    await vi.waitUntil(() => seen.links.includes('failed'), { timeout: 20_000, interval: 50 })
    expect(logs.some((l) => l.event === 'tmux-reconnect-failed')).toBe(true)
    expect(running(pane.pid)).toBe(true)
    expect(seen.exits).toEqual([])
    rmSync(silent)
    pane.retryLink()
    await vi.waitUntil(() => seen.links.at(-1) === 'up', POLL)
    const after = seen.text().length
    await vi.waitUntil(() => seen.text().length > after + 20, POLL)
  }, 40_000)

  it('KSH-C109 ends the pane with a lost status only when the tmux server itself is gone', async () => {
    const { server, sock } = await connect()
    const pane = await spawnSh(server, 'sleep 30')
    const seen = watch(pane)
    execFileSync(tmux, ['-u', '-S', sock, 'kill-server'], { env })
    await vi.waitUntil(() => seen.exits.length > 0, POLL)
    expect(seen.exits).toEqual([1])
  })

  it('KSH-C111 ends the control client by closing its input, never by signal, when Ostia stops', async () => {
    const fake = join(root, `trap-tmux-${names}`)
    const signalled = join(root, `signalled-${names}`)
    writeFileSync(
      fake,
      `#!/bin/sh\ncase "$*" in *" -C "*) exec 3<&0; trap 'touch "${signalled}"' TERM; "${tmux}" "$@" <&3 3<&- & wait;; *) exec "${tmux}" "$@";; esac\n`,
      { mode: 0o755 },
    )
    const { server, sock } = await connect(fake)
    await spawnSh(server, 'sleep 30')
    server.close()
    await vi.waitUntil(() => controlClientPids(sock).length === 0, POLL)
    expect(existsSync(signalled)).toBe(false)
    execFileSync(tmux, ['-u', '-S', sock, 'kill-server'], { env })
  })
})
