import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { type AddressInfo, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import type { IPty } from 'node-pty'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SANDBOX_GLOBALS, type SandboxSwitches } from '../../shared/sandbox/sandbox'
import { PortBridge } from './portBridge'
import { PortForwarder } from './portForwarder'
import { PortRequests } from './portRequests'
import { sandboxedShellCommand, wrapForTerminal } from './ptyWrap'
import { SandboxStore } from './store'
import { WorkspaceSandboxes } from './workspaceSandboxes'

const repoRoot = process.cwd()
const hostScript = join(repoRoot, 'node_modules/.cache/ostia-test/sandbox-host-relay.mjs')
const nodePty = await import('node-pty').catch(() => null)
const runnable = process.platform === 'linux' && nodePty !== null

const SHELL_ARGV = '/usr/bin/env bash --norc --noprofile -i'
const PROMPT = /bash-[\d.]+\$ /

let root: string
let home: string
let workDir: string

interface Session {
  term: IPty
  pipe: string | null
  bridge: PortBridge | null
  sandboxes: WorkspaceSandboxes
  output: () => string
  seen: (text: string | RegExp, from?: number) => Promise<number>
  exited: Promise<number>
}

const open: Session[] = []

async function start(
  name: string,
  switches: Partial<SandboxSwitches> = {},
  { relay = true, ports = false } = {},
): Promise<Session> {
  if (!nodePty) throw new Error('node-pty is not available')
  const store = new SandboxStore(join(root, `${name}.json`))
  store.set('ws', { enabled: true, allowRead: [], domains: [], controls: {}, switches })
  const sandboxes = new WorkspaceSandboxes({
    store,
    globals: () => ({ ...DEFAULT_SANDBOX_GLOBALS, allowRead: [] }),
    basePaths: () => ({
      home,
      dataDirs: [join(home, '.local/share/ostia')],
      socketPath: join(root, 'ostia.sock'),
      runtimeReads: [],
    }),
    workDir: () => workDir,
    tmpRoot: join(root, 'tmp', name),
    nodePath: process.execPath,
    hostScript,
    onAsk: async () => false,
  })
  const pipe = relay ? join(sandboxes.tmpDir('ws'), 'resize-test') : null
  if (ports) await sandboxes.connect('ws')
  const bridge = ports ? await PortBridge.open(sandboxes.tmpDir('ws')) : null
  const wrapped = await sandboxes.wrap(
    'ws',
    sandboxedShellCommand(SHELL_ARGV, '/bin/bash', pipe, bridge?.command ?? null),
    'bash',
  )
  const term = nodePty.spawn('/bin/sh', ['-c', wrapForTerminal(wrapped, pipe)], {
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
  const session = { term, pipe, bridge, sandboxes, output: () => buffer, seen, exited }
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

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

async function exposeAndServe(session: Session, marker: string): Promise<string> {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}/`
  const forwarder = new PortForwarder({
    panesOf: () => [{ pid: session.term.pid, bridge: session.bridge }],
    unixSocketsOff: () => false,
  })
  const requests = new PortRequests({
    platform: 'linux',
    isSandboxed: () => true,
    policy: () => 'ask',
    ask: async () => {
      await expect(fetch(url)).rejects.toThrow()
      return 'workspace'
    },
    forwarder,
  })
  await expect.poll(() => session.bridge?.connected, { timeout: 10_000 }).toBe(true)
  try {
    expect(await requests.request('ws', 'pane', String(port))).toEqual({ ok: true, port })
    const server = `require("http").createServer((q,r)=>r.end("${marker}")).listen(${port},"127.0.0.1")`
    session.term.write(`${process.execPath} -e '${server}' &\r`)
    let body = ''
    await expect
      .poll(
        async () => {
          body = await fetch(url).then(
            (res) => res.text(),
            () => '',
          )
          return body
        },
        { timeout: 20_000 },
      )
      .toBe(marker)
    return body
  } finally {
    forwarder.stopAll()
  }
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-relay-')))
  home = join(root, 'home')
  workDir = join(home, 'proj')
  mkdirSync(workDir, { recursive: true })
  mkdirSync(join(home, '.local/share/ostia'), { recursive: true })
})

afterEach(() => {
  for (const session of open.splice(0)) {
    session.term.kill()
    session.bridge?.close()
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
        'echo "tty=$(tty) leader=$(ps -o sid= -p $$ | tr -d " ")/$$ outer=${OSTIA_RELAY_TTY-unset} shell=$SHELL"',
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
      expect(existsSync(session.pipe ?? '')).toBe(true)
      session.term.write('exit 7\r')
      expect(await session.exited).toBe(7)
      expect(existsSync(session.pipe ?? '')).toBe(false)
    }, 60_000)

    it('SBX-C45 ostia sandbox expose forwards the port on this computer to a server in the sandbox once the human allows it, behind the pty relay', async () => {
      const session = await start('expose-relay', {}, { ports: true })
      expect(await exposeAndServe(session, 'INSIDE-C45')).toBe('INSIDE-C45')
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

describe.skipIf(nodePty === null)('a sandboxed shell on the pane’s own terminal', () => {
  it('a sandboxed shell survives Ctrl+C, which still interrupts its command, and has a temp folder that exists', async () => {
    const session = await start('own-signals', {}, { relay: false })
    const typed = session.output().length
    session.term.write('half-typed')
    const half = await session.seen('half-typed', typed)
    session.term.write('\x03')
    await session.seen(PROMPT, half)

    const sleeping = session.output().length
    session.term.write(`sh -c 'echo SLEEPING-$((1+2)); exec sleep 30'; echo SLEPT-$((2+3))\r`)
    await session.seen('SLEEPING-3', sleeping)
    session.term.write('\x03')
    await run(session, 'echo ALIVE-$((6*7))', 'ALIVE-42')
    if (process.platform !== 'darwin') {
      expect(session.output().slice(sleeping)).not.toContain('SLEPT-5')
    }

    expect(
      await run(
        session,
        'touch "$TMPDIR/probe" && test -d "$TMPDIR" && echo TMP-$((4+4))',
        'TMP-8',
      ),
    ).toContain('TMP-8')
  }, 60_000)

  it.skipIf(process.platform !== 'linux')(
    'SBX-C45 ostia sandbox expose forwards the port on this computer to a server in the sandbox once the human allows it, on the pane’s own terminal',
    async () => {
      const session = await start('expose-own', {}, { relay: false, ports: true })
      expect(await exposeAndServe(session, 'INSIDE-C45')).toBe('INSIDE-C45')
    },
    60_000,
  )
})
