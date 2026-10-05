import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { programPath } from '../systemRequirements'
import { type TmuxPane, TmuxServer, TmuxSocketDirError, serverEnv } from './tmuxServer'

const tmux = programPath('tmux') ?? 'tmux'
const root = mkdtempSync(join(tmpdir(), 'ostia-tmux-'))
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
const env = { ...process.env, HOME: home }
const servers: TmuxServer[] = []
let names = 0

afterEach(async () => {
  for (const server of servers.splice(0)) await server.killServer()
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

async function connect(dir = join(root, 'sock')): Promise<TmuxServer> {
  const server = await TmuxServer.connect(
    { tmux, dir, name: `t${names++}`, defaultTerminal: 'screen-256color', env },
    () => undefined,
  )
  servers.push(server)
  return server
}

function collect(pane: TmuxPane): { text: () => string } {
  let text = ''
  pane.onData((d) => {
    text += d
  })
  return { text: () => text }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function spawnSh(server: TmuxServer, script: string, cols = 80, rows = 24): Promise<TmuxPane> {
  return server.spawn({
    file: '/bin/sh',
    args: ['-c', script],
    cwd: root,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
    cols,
    rows,
    meta: { paneId: 'p1' },
  })
}

describe('TmuxServer', () => {
  it('KSH-C23 starts a shell at the size it was asked for', async () => {
    const server = await connect()
    const pane = await spawnSh(server, 'stty size; sleep 5', 154, 40)
    const out = collect(pane)
    await until(() => out.text().includes('40 154'))
  })

  it('KSH-C30 passes Ctrl+B to the program instead of acting as a prefix', async () => {
    const server = await connect()
    const pane = await spawnSh(server, 'exec cat -v')
    const out = collect(pane)
    pane.write('a\x02b\r')
    await until(() => out.text().includes('a^Bb'))
  })

  it('KSH-C4 runs its own server that ignores the human tmux config and server', async () => {
    writeFileSync(join(home, '.tmux.conf'), 'set -g @human-config yes\nset -g status on\n')
    const humanEnv = { ...env, TMUX_TMPDIR: join(root, 'human') }
    mkdirSync(humanEnv.TMUX_TMPDIR, { recursive: true })
    execFileSync(tmux, ['new-session', '-d', '-s', 'mine'], { env: humanEnv })
    try {
      const server = await connect()
      await spawnSh(server, 'sleep 5')
      const status = await server.command('show -gv status')
      const human = await server.command('show -gqv @human-config')
      expect(status).toEqual(['off'])
      expect(human).toEqual([])
      const humanWindows = execFileSync(tmux, ['list-windows', '-a'], {
        env: humanEnv,
        encoding: 'utf8',
      })
      expect(humanWindows.trim().split('\n')).toHaveLength(1)
    } finally {
      execFileSync(tmux, ['kill-server'], { env: humanEnv })
      rmSync(join(home, '.tmux.conf'))
    }
  })

  it('KSH-C5 refuses a socket folder that is open to others or a symlink', async () => {
    const open = join(root, 'open')
    mkdirSync(open, { mode: 0o755 })
    chmodSync(open, 0o755)
    await expect(connect(open)).rejects.toBeInstanceOf(TmuxSocketDirError)
    const target = join(root, 'target')
    mkdirSync(target, { mode: 0o700 })
    const link = join(root, 'link')
    symlinkSync(target, link)
    await expect(connect(link)).rejects.toBeInstanceOf(TmuxSocketDirError)
  })

  it('KSH-C6 keeps two instances apart, each listing only its own windows', async () => {
    const dev = await connect()
    const installed = await connect()
    await spawnSh(dev, 'sleep 5')
    expect(await dev.windows()).toHaveLength(1)
    expect(await installed.windows()).toHaveLength(0)
  })

  it('KSH-C25 never sends a resize for a zero size', async () => {
    const server = await connect()
    const pane = await spawnSh(server, 'sleep 5', 100, 30)
    const sent = vi.spyOn(server, 'send')
    pane.resize(0, 0)
    pane.resize(0, 12)
    pane.resize(90, 0)
    expect(sent.mock.calls.filter(([line]) => line.startsWith('resize-window'))).toEqual([])
    pane.resize(90, 20)
    expect(sent.mock.calls.filter(([line]) => line.startsWith('resize-window'))).toHaveLength(1)
  })

  it('KSH-C43 lets the human start their own tmux inside a kept pane', async () => {
    const server = await connect()
    const humanTmp = join(root, 'nested')
    mkdirSync(humanTmp, { recursive: true })
    const pane = await spawnSh(
      server,
      `echo "tmux=\${TMUX-unset}"; TMUX_TMPDIR=${humanTmp} ${tmux} new-session -d -s inner && echo nested-ok; TMUX_TMPDIR=${humanTmp} ${tmux} kill-server; sleep 5`,
    )
    const out = collect(pane)
    await until(() => out.text().includes('nested-ok'))
    expect(out.text()).toContain('tmux=unset')
  })

  it('reports a shell that exits with its code', async () => {
    const server = await connect()
    const pane = await spawnSh(server, 'exit 7')
    const code = await new Promise<number>((resolve) => pane.onExit((e) => resolve(e.exitCode)))
    expect(code).toBe(7)
  })

  it('keeps only the variables a pane is given from the server environment', () => {
    expect(serverEnv({ PATH: '/bin', HOME: '/h', OSTIA_TOKEN: 'x', SECRET: 'y' })).toEqual({
      PATH: '/bin',
      HOME: '/h',
    })
  })
})
