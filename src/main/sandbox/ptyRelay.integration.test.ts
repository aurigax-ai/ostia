import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import type { IPty } from 'node-pty'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SANDBOX_GLOBALS, type SandboxSwitches } from '../../shared/sandbox'
import { sandboxedShellCommand, wrapForTerminal } from './ptyWrap'
import { SandboxStore } from './store'
import { WorkspaceSandboxes } from './workspaceSandboxes'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/pine-test/sandbox-host-relay.mjs')
const nodePty = await import('node-pty').catch(() => null)
const runnable = process.platform === 'linux' && nodePty !== null

const SHELL_ARGV = '/usr/bin/env bash --norc --noprofile -i'
const PROMPT = /bash-[\d.]+\$ /

let root: string
let home: string
let workDir: string

interface Session {
  term: IPty
  pipe: string
  sandboxes: WorkspaceSandboxes
  output: () => string
  seen: (text: string | RegExp, from?: number) => Promise<number>
  exited: Promise<number>
}

const open: Session[] = []

async function start(name: string, switches: Partial<SandboxSwitches> = {}): Promise<Session> {
  if (!nodePty) throw new Error('node-pty is not available')
  const store = new SandboxStore(join(root, `${name}.json`))
  store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {}, switches })
  const sandboxes = new WorkspaceSandboxes({
    store,
    globals: () => ({ ...DEFAULT_SANDBOX_GLOBALS, allowRead: [] }),
    basePaths: () => ({
      home,
      dataDirs: [join(home, '.local/share/pine')],
      socketPath: join(root, 'pine.sock'),
      runtimeReads: [],
    }),
    workDir: () => workDir,
    tmpRoot: join(root, 'tmp', name),
    nodePath: process.execPath,
    hostScript,
    onAsk: async () => false,
  })
  const pipe = join(sandboxes.tmpDir('ws'), 'resize-test')
  const wrapped = await sandboxes.wrap(
    'ws',
    sandboxedShellCommand(SHELL_ARGV, '/bin/bash', pipe),
    'bash',
  )
  const term = nodePty.spawn('/bin/sh', ['-c', wrapForTerminal(wrapped, pipe, 'linux')], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: workDir,
    env: { ...process.env, HOME: home, TMPDIR: sandboxes.tmpDir('ws') },
  })
  let buffer = ''
  term.onData((data) => {
    buffer += data
  })
  const seen = async (text: string | RegExp, from = 0): Promise<number> => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const rest = buffer.slice(from)
      const at = typeof text === 'string' ? rest.indexOf(text) : rest.search(text)
      if (at >= 0) return from + at
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`never saw ${String(text)} in ${JSON.stringify(buffer.slice(from))}`)
  }
  const exited = new Promise<number>((resolve) => term.onExit((e) => resolve(e.exitCode)))
  const session = { term, pipe, sandboxes, output: () => buffer, seen, exited }
  open.push(session)
  await seen(PROMPT)
  return session
}

async function run(session: Session, command: string, expected: string | RegExp): Promise<string> {
  const from = session.output().length
  session.term.write(`${command}\r`)
  const at = await session.seen(expected, from)
  await session.seen(PROMPT, at)
  return session.output().slice(from)
}

async function startSleep(session: Session): Promise<number> {
  const from = session.output().length
  session.term.write(`sh -c 'echo SLEEPING; exec sleep 30'\r`)
  return session.seen('SLEEPING\r', from)
}

beforeAll(async () => {
  await build({
    entryPoints: [join(repoRoot, 'src/main/sandbox/host.ts')],
    outfile: hostScript,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  })
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-relay-')))
  home = join(root, 'home')
  workDir = join(home, 'proj')
  mkdirSync(workDir, { recursive: true })
  mkdirSync(join(home, '.local/share/pine'), { recursive: true })
})

afterEach(() => {
  for (const session of open.splice(0)) {
    session.term.kill()
    session.sandboxes.stopAll()
  }
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!runnable)(
  'the pty relay in a real sandbox (Linux only: TIOCSTI relay under bwrap)',
  () => {
    it('gives the shell a controlling terminal of its own in a session bwrap started', async () => {
      const session = await start('ctty')
      const out = await run(
        session,
        'echo "tty=$(tty) leader=$(ps -o sid= -p $$ | tr -d " ")/$$ outer=${PINE_RELAY_TTY-unset} shell=$SHELL"',
        /tty=\S+ leader/,
      )
      expect(out).toMatch(/tty=\/dev\/pts\/\d+ leader=(\d+)\/\1 outer=unset shell=\/bin\/bash/)
    }, 60_000)

    it('leaves no sandboxed process with the pane’s terminal as its controlling terminal', async () => {
      const session = await start('outer')
      const outerTty = await run(
        session,
        'echo "relay=$(ps -o comm= -p $PPID) on=$(ps -o tty= -p $PPID | tr -d " ")="',
        /relay=\S+ on=\S*=/,
      )
      expect(outerTty).toMatch(/relay=script on=\?=/)
      const ttys = await run(
        session,
        'echo "ttys=$(ps -eo tty= | sort -u | tr -d " " | tr "\n" ,)="',
        /ttys=[^$]*=\r/,
      )
      expect(ttys).toMatch(/ttys=\?,pts\/\d+,=/)
    }, 60_000)

    it('interrupts, quits and suspends the running command and leaves the shell alive', async () => {
      const session = await start('signals')
      await startSleep(session)
      session.term.write('\x03')
      expect(await run(session, 'echo "rc=$?"', /rc=\d+/)).toContain('rc=130')

      await startSleep(session)
      session.term.write('\x1c')
      expect(await run(session, 'echo "rc=$?"', /rc=\d+/)).toContain('rc=131')

      const suspended = await startSleep(session)
      session.term.write('\x1a')
      await session.seen('Stopped', suspended)
      const resumed = session.output().length
      session.term.write('fg\r')
      await session.seen("exec sleep 30'\r\n", resumed)
      await new Promise((r) => setTimeout(r, 200))
      session.term.write('\x03')
      expect(await run(session, 'echo "rc=$?"', /rc=\d+/)).toContain('rc=130')
    }, 60_000)

    it('passes a resize of the pane’s terminal on to the shell and its foreground command', async () => {
      const session = await start('resize')
      expect(await run(session, 'stty size', /\d+ \d+\r/)).toContain('24 80')
      session.term.resize(100, 30)
      await expect
        .poll(async () => run(session, 'stty size', /\d+ \d+\r/), { timeout: 10_000 })
        .toContain('30 100')

      const from = session.output().length
      session.term.write(
        `sh -c 'trap "echo GOT-WINCH; exit 0" WINCH; echo READY; sleep 20 & wait'\r`,
      )
      await session.seen('READY\r', from)
      session.term.resize(90, 20)
      await session.seen('GOT-WINCH\r', from)
    }, 60_000)

    it('passes shell-integration marks through unchanged and echoes typed keys once', async () => {
      const session = await start('bytes')
      const marks = await run(
        session,
        String.raw`printf '\033]133;C\007out\033]633;E;a\\x3bb\007\033]133;D;0\007\n'`,
        '\x1b]133;D;0\x07',
      )
      expect(marks).toContain('\x1b]133;C\x07out\x1b]633;E;a\\x3bb\x07\x1b]133;D;0\x07\r\n')

      const from = session.output().length
      session.term.write('cat\r')
      await session.seen('cat\r\n', from)
      const typed = session.output().length
      session.term.write('relayed\r')
      await session.seen('relayed\r\nrelayed\r\n', typed)
      session.term.write('\x04')
      await session.seen(PROMPT, typed)
      expect(
        session
          .output()
          .slice(typed)
          .match(/relayed/g),
      ).toHaveLength(2)
    }, 60_000)

    it('exits with the shell’s code and removes the resize pipe', async () => {
      const session = await start('exit')
      expect(existsSync(session.pipe)).toBe(true)
      session.term.write('exit 7\r')
      expect(await session.exited).toBe(7)
      expect(existsSync(session.pipe)).toBe(false)
    }, 60_000)

    it('works with Unix sockets blocked, where srt runs the shell under its seccomp helper', async () => {
      const session = await start('seccomp', { unixSockets: false })
      await startSleep(session)
      session.term.write('\x03')
      expect(await run(session, 'echo "rc=$?"', /rc=\d+/)).toContain('rc=130')
      session.term.write('exit 3\r')
      expect(await session.exited).toBe(3)
    }, 60_000)
  },
)
