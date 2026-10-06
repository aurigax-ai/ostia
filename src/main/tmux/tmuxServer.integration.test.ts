import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { programPath } from '../systemRequirements'
import { type TmuxPane, TmuxServer, TmuxSocketDirError, serverEnv } from './tmuxServer'

const tmux = programPath('tmux') ?? 'tmux'
const tmuxVersion = Number(/(\d+\.\d+)/.exec(execFileSync(tmux, ['-V'], { encoding: 'utf8' }))?.[1])
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

async function connect(dir = join(root, 'sock'), name = `t${names++}`): Promise<TmuxServer> {
  const server = await TmuxServer.connect(
    { tmux, dir, name, defaultTerminal: 'screen-256color', env },
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

async function rendered(...chunks: string[]): Promise<string> {
  const term = new Terminal({ cols: 80, rows: 24, scrollback: 10_000 })
  for (const chunk of chunks) await new Promise<void>((resolve) => term.write(chunk, resolve))
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y++) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
  }
  term.dispose()
  return lines.join('\n')
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

  it('KSH-C14 shows output that arrives during a snapshot exactly once and in order', async () => {
    const server = await connect()
    await spawnSh(
      server,
      'i=0; while [ $i -lt 4000 ]; do echo n$i; i=$((i+1)); done; sleep 5',
      80,
      24,
    )
    await new Promise((r) => setTimeout(r, 30))
    const again = await connect(join(root, 'sock'), basename(server.socketPath))
    const [kept] = await again.windows()
    if (!kept) throw new Error('the window is gone')
    const pane = again.adopt(kept)
    let after = ''
    pane.onData((d) => {
      after += d
    })
    const screen = await pane.snapshot(80, 24)
    pane.live()
    await until(() => after.includes('n3999') || screen.includes('n3999'))
    const shown = await rendered(screen, after)
    const numbers = [...shown.matchAll(/n(\d+)/g)].map((m) => Number(m[1]))
    const first = numbers[0] ?? 0
    expect(numbers).toEqual(Array.from({ length: 4000 - first }, (_, i) => first + i))
  })

  it('hands a new pane the output it printed before tmux reported the window', async () => {
    const server = await connect()
    const panes = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        spawnSh(server, `echo early-${n}; sleep 5`).then((pane) => ({ n, out: collect(pane) })),
      ),
    )
    for (const { n, out } of panes) await until(() => out.text().includes(`early-${n}`))
  })

  it.skipIf(tmuxVersion < 3.7)(
    'KSH-C66 replays bracketed paste for a program that turned it on (tmux 3.7 and later)',
    async () => {
      const server = await connect()
      const pane = await spawnSh(server, "printf '\\033[?2004hpaste-on'; sleep 5")
      const out = collect(pane)
      await until(() => out.text().includes('paste-on'))
      const screen = await pane.snapshot(80, 24)
      pane.live()
      expect(screen).toContain('\x1b[?2004h')
    },
  )

  it('KSH-C66 pastes with markers only into a program that asked for bracketed paste', async () => {
    const server = await connect()
    const ready = 'stty raw -echo; echo ready; exec cat -v'
    const bracketed = await spawnSh(server, `printf '\\033[?2004h'; ${ready}`)
    const outBracketed = collect(bracketed)
    const plain = await spawnSh(server, ready)
    const outPlain = collect(plain)
    await until(() => outBracketed.text().includes('ready') && outPlain.text().includes('ready'))
    bracketed.paste('line-1\rline-2')
    plain.paste('line-1\rline-2')
    await until(() => outBracketed.text().includes('^[[200~line-1^Mline-2^[[201~'))
    await until(() => outPlain.text().includes('line-1^Mline-2'))
    expect(outPlain.text()).not.toContain('200~')
  })

  it('KSH-C65 says what tmux printed when it could not start its server', async () => {
    const fake = join(root, 'failing-tmux')
    writeFileSync(fake, '#!/bin/sh\necho "server refused-42" >&2\nexit 1\n', { mode: 0o755 })
    await expect(
      TmuxServer.connect(
        { tmux: fake, dir: join(root, 'sock'), name: 'failing', defaultTerminal: 'xterm', env },
        () => undefined,
      ),
    ).rejects.toThrow('tmux could not start its server: server refused-42')
  })

  it('reports a shell that exits with its code', { retry: 2 }, async () => {
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
