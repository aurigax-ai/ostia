import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneEntry } from '../main/panes/paneList'

const dir = mkdtempSync(join(tmpdir(), 'ostia-cli-codex-'))
process.env.XDG_DATA_HOME = join(dir, 'data')

const request = vi.fn(async () => 'once' as const)
vi.mock('../main/approvals/approvals', () => ({ approvals: () => ({ request }) }))

const { registerBusMethods } = await import('../main/agents/busMethods')
const { flushBus, resetBus } = await import('../main/agents/busStore')
const { registerCodexMail } = await import('../main/agents/codexMailWiring')
const { registerCodexSocket } = await import('../main/agents/codexSockets')
const { registerControlServer, stopControlServer } = await import('../main/control/controlServer')
const { registerPane } = await import('../main/control/idRegistry')
const { PaneJournal } = await import('../main/panes/paneJournal')

const cliPath = join(process.cwd(), 'out', 'cli', 'index.js')
const socketPath = join(dir, 'control.sock')
const bin = join(dir, 'bin')
const agentDir = join(dir, 'agent')
const codexSock = join(dir, 'pane.codex.sock')
const log = join(dir, 'fake-codex.log')
const fixture = join(process.cwd(), 'test', 'fixtures', 'agents', 'fake-codex.mjs')

const boss = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'cx-boss' })
const worker = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'cx-worker' })

let thread = 'thread-1'
const journal = new PaneJournal({
  terminal: () => undefined,
  exited: () => false,
  now: Date.now,
} as never)

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function run(pane: typeof boss, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: dir,
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: dir,
        OSTIA_SOCKET: socketPath,
        OSTIA_TOKEN: pane.token,
        OSTIA_AGENT_DIR: agentDir,
        OSTIA_CODEX_SOCK: codexSock,
        FAKE_CODEX_LOG: log,
        FAKE_CODEX_WS: createRequire(import.meta.url).resolve('ws'),
      },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`ostia timed out (${stdout} ${stderr})`))
    }, 40_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end('')
  })
}

const logged = (): Record<string, unknown>[] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

beforeAll(() => {
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(agentDir, 'codex'), { recursive: true })
  writeFileSync(
    join(agentDir, 'codex', 'hook-args.json'),
    JSON.stringify(['--no-daemon', '-c', 'hooks.x=1']),
  )
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`)
  chmodSync(join(bin, 'codex'), 0o755)
  registerCodexSocket(worker.externalId, codexSock)
  registerBusMethods({
    hibernated: () => false,
    managerSendAllowed: () => true,
    agentBusy: () => false,
    announce: () => {},
    pending: async () => 'idle-will-wake',
    reach: {
      processPane: async () => [],
      visible: async () => () => true,
      inScope: async () => true,
      isChild: () => false,
      isSandboxed: () => false,
      isConfined: () => false,
    },
  })
  registerCodexMail({
    journal,
    version: 'test',
    panes: async () =>
      [
        {
          paneId: worker.externalId,
          workspaceId: 'ws1',
          kind: 'terminal',
          title: 'codex worker',
          running: true,
          blockCount: 0,
          agent: 'codex',
          agentSessionId: thread,
        },
      ] as PaneEntry[],
  })
  registerControlServer(
    {
      execCommand: async () => ({ ok: true }) as never,
      listCommandsFor: () => [],
      getTerminalState: () => undefined,
      isSandboxed: () => false,
    },
    socketPath,
  )
})

beforeEach(async () => {
  await resetBus()
  rmSync(join(dir, 'data', 'ostia', 'bus.json'), { force: true })
  rmSync(log, { force: true })
  thread = 'thread-1'
})

afterAll(async () => {
  await run(worker, ['codex-server', 'stop'])
  stopControlServer()
  await flushBus()
  rmSync(dir, { recursive: true, force: true })
})

describe('codex-server through the real CLI with a fake codex', () => {
  it('starts app-server for the pane, then a message for it becomes a turn/start with nothing typed', async () => {
    const started = await run(worker, ['codex-server', 'start', '--', 'resume', 'abc'])
    expect(started).toMatchObject({ code: 0, stdout: `${codexSock}\n` })
    const [first] = logged()
    expect(first).toMatchObject({
      started: ['--no-daemon', '-c', 'hooks.x=1', 'app-server', '--listen', `unix://${codexSock}`],
      codexArgs: 'resume\u001fabc',
    })

    const sent = await run(boss, ['bus', 'send', worker.externalId, 'the review is green'])
    expect(sent.code).toBe(0)
    await vi.waitFor(
      () =>
        expect(
          logged().some((e) => (e.received as { method?: string })?.method === 'turn/start'),
        ).toBe(true),
      {
        timeout: 15_000,
      },
    )
    const methods = logged().flatMap((e) =>
      e.received ? [(e.received as { method?: string }).method] : [],
    )
    expect(methods).toEqual(['initialize', 'initialized', 'turn/start'])
    const turn = logged().find((e) => (e.received as { method?: string })?.method === 'turn/start')
      ?.received as { params: { threadId: string; input: { type: string; text: string }[] } }
    expect(turn.params.threadId).toBe('thread-1')
    expect(turn.params.input[0]).toMatchObject({ type: 'text' })
    expect(turn.params.input[0].text).toContain('the review is green')
    await vi.waitFor(async () =>
      expect((await run(boss, ['bus', 'sent'])).stdout).toContain('\tdelivered:turn\t'),
    )

    const stopped = await run(worker, ['codex-server', 'stop'])
    expect(stopped.code).toBe(0)
    await vi.waitFor(() => expect(logged().some((e) => e.stopped === true)).toBe(true))
    expect(existsSync(codexSock)).toBe(false)
  }, 90_000)

  it('starts nothing when the user brought their own --remote', async () => {
    const res = await run(worker, ['codex-server', 'start', '--', '--remote', 'ws://elsewhere'])
    expect(res).toMatchObject({ code: 0, stdout: '' })
    expect(logged()).toEqual([])
  }, 30_000)

  it('keeps the message queued when codex refuses the turn', async () => {
    thread = 'refuse-me'
    await run(worker, ['codex-server', 'start', '--'])
    await run(boss, ['bus', 'send', worker.externalId, 'refused one'])
    await vi.waitFor(
      () =>
        expect(
          logged().some((e) => (e.received as { method?: string })?.method === 'turn/start'),
        ).toBe(true),
      {
        timeout: 15_000,
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect((await run(boss, ['bus', 'sent'])).stdout).toContain('\tqueued')
    await run(worker, ['codex-server', 'stop'])
  }, 90_000)
})
