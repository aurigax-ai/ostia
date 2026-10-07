import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalOutcome } from '../shared/approvals'
import type { CommandResult } from '../shared/types'

let answer: ApprovalOutcome = 'deny'
const request = vi.fn(async () => answer)

vi.mock('../main/approvals', () => ({ approvals: () => ({ request }) }))

const { registerControlServer, stopControlServer } = await import('../main/controlServer')
const { getByPaneId, registerPane } = await import('../main/idRegistry')
const { registerPaneIoMethods } = await import('../main/paneIo')
const { registerProcessMethods } = await import('../main/processManager')
const { PtyRingBuffer } = await import('../main/ptyRingBuffer')

type OpenRequest = Parameters<Parameters<typeof registerProcessMethods>[0]['openTab']>[0]

const cliPath = join(process.cwd(), 'out', 'cli', 'index.js')
const PROMPT = '\x1b]133;A\x1b\\% \x1b]133;B\x1b\\'
const C = '\x1b]133;C\x1b\\'
const exit = (code: number): string => `\x1b]133;D;${code}\x1b\\`

const rings = new Map<string, InstanceType<typeof PtyRingBuffer>>()
const opened: OpenRequest[] = []
const written: { paneId: string; data: string }[] = []
const reruns: { paneId: string; command: string }[] = []
const closedPanes: string[] = []
let tabSeq = 0

const registry = registerProcessMethods({
  isSandboxed: () => false,
  openTab: async (req) => {
    opened.push(req)
    tabSeq += 1
    const paneId = `tab-${tabSeq}`
    rings.set(paneId, new PtyRingBuffer())
    return registerPane({ windowId: 'w1', workspaceId: req.workspaceId ?? '', paneId }).externalId
  },
  ring: (paneId) => {
    const ring = rings.get(paneId)
    return ring ? (from) => ring.since(from) : undefined
  },
  writePane: (paneId, data) => {
    written.push({ paneId, data })
    if (data === '\x03') emit(paneId, `^C\r\n${exit(130)}${PROMPT}`)
    return true
  },
  endShell: (paneId) => {
    rings.delete(paneId)
  },
  hasShell: (paneId) => rings.has(paneId),
  runInPane: (paneId, command) => {
    reruns.push({ paneId, command })
    return true
  },
  cwdOfPane: () => undefined,
  agentArgv: (name) => (name === 'claude' ? ['claude'] : null),
  interruptGraceMs: 50,
})

registerPaneIoMethods({
  io: {
    read: async (paneId, lines) => `screen of ${paneId} (${lines})`,
    write: (paneId, data) => {
      written.push({ paneId, data })
      return true
    },
    bracketedPaste: () => false,
    outputCursor: () => undefined,
  },
  state: (paneId) => ({ paneId, generation: 1, cwd: '/w', running: true, blockCount: 1 }),
  processPane: (ref, ctx) => {
    const entry = registry.resolve(ref, ctx.identity, false)
    return entry && entry.status !== 'closed' ? entry.paneId : undefined
  },
  isChild: (ownerPaneId, paneId) => registry.isChild(ownerPaneId, paneId),
  createdWorkspace: (creatorPaneId, workspaceId) => registry.created(creatorPaneId, workspaceId),
  isSandboxed: () => false,
  isConfined: () => false,
  managerAllowsInput: () => false,
  attention: async () => ({}),
  inputSent: () => {},
  hibernated: async () => false,
  wake: async () => false,
  close: async (pane) => {
    closedPanes.push(pane.paneId)
    return { ok: true, result: undefined }
  },
  delay: async () => {},
})

function emit(paneId: string, data: string): void {
  const ring = rings.get(paneId)
  if (!ring) return
  ring.push(data)
  registry.feed(paneId, data, ring.end)
}

const agent = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'agent-pane' })
const other = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'other-pane' })

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

let socketPath = ''
let seq = 0
let home = ''
const liveChildren = new Set<ReturnType<typeof spawn>>()

function ostia(args: string[], cwd = home): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, OSTIA_SOCKET: socketPath, OSTIA_TOKEN: agent.token },
    })
    liveChildren.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      liveChildren.delete(child)
      resolve({ code, stdout, stderr })
    })
  })
}

async function run(cmd: string, ...flags: string[]): Promise<{ id: string; tab: string }> {
  const res = await ostia(['process', 'run', cmd, ...flags])
  expect(res.stderr).toBe('')
  return { id: JSON.parse(res.stdout).id, tab: `tab-${tabSeq}` }
}

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-cli-proc-')))
  mkdirSync(join(home, 'api'))
})

afterAll(() => {
  for (const child of liveChildren) child.kill('SIGKILL')
  rmSync(home, { recursive: true, force: true })
})

beforeEach(() => {
  seq += 1
  socketPath = join(tmpdir(), `ostia-cli-proc-${process.pid}-${seq}.sock`)
  registerControlServer(
    {
      execCommand: async () => ({ ok: true }) as CommandResult,
      listCommandsFor: () => [],
      getTerminalState: () => undefined,
      isSandboxed: () => false,
    },
    socketPath,
  )
  answer = 'deny'
  request.mockClear()
  opened.length = 0
  written.length = 0
  reruns.length = 0
  closedPanes.length = 0
})

afterEach(() => {
  stopControlServer()
  registry.workspaceClosed('ws1')
})

describe('ostia process (the real CLI against a live control server)', () => {
  it('run: opens a tab with a long quoted command line exactly as the caller wrote it', async () => {
    const cmd = `claude 'review "src/main" && say it\\'s done' --model opus -p "two words"`
    const res = await ostia(['process', 'run', cmd, '--name', 'reviewer', '--cwd', 'api'])

    expect(res.stderr).toBe('')
    expect(res.code).toBe(0)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({
      command: cmd,
      title: 'reviewer',
      cwd: join(home, 'api'),
      afterPaneId: 'agent-pane',
      backgroundTab: true,
    })
    const started = JSON.parse(res.stdout)
    expect(started).toMatchObject({ name: 'reviewer' })
    expect(Object.keys(started).sort()).toEqual(['id', 'name', 'paneId'])
  })

  it('run --split-tab: the first opens its own tab, later ones join the newest member', async () => {
    const first = await ostia(['process', 'run', 'pnpm web', '--split-tab', 'dev'])
    expect(first.stderr).toBe('')
    expect(opened[0]).toMatchObject({
      backgroundTab: true,
      splitTab: { name: 'dev', side: 'right' },
    })
    expect(opened[0].splitTab).not.toHaveProperty('joinPaneId')
    const firstTab = `tab-${tabSeq}`

    await ostia(['process', 'run', 'pnpm api', '--split-tab', 'dev', '--split', 'down'])
    expect(opened[1]).toMatchObject({
      splitTab: { name: 'dev', side: 'down', joinPaneId: firstTab },
    })
    const secondTab = `tab-${tabSeq}`

    await ostia(['agent', 'run', 'claude', '--split-tab', 'dev', 'watch the logs'])
    expect(opened[2]).toMatchObject({ splitTab: { name: 'dev', joinPaneId: secondTab } })

    await ostia(['process', 'run', 'pnpm docs', '--split-tab', 'other'])
    expect(opened[3].splitTab).toEqual({ name: 'other', side: 'right' })
    const listed = await ostia(['process', 'ls'])
    expect(listed.code).toBe(0)
  })

  it('run --split-tab: skips a member whose tab the human closed', async () => {
    await ostia(['process', 'run', 'pnpm web', '--split-tab', 'gone'])
    registry.paneClosed(`tab-${tabSeq}`)
    await ostia(['process', 'run', 'pnpm api', '--split-tab', 'gone'])
    expect(opened[1].splitTab).toEqual({ name: 'gone', side: 'right' })
  })

  it('run: refuses --split without --split-tab and a side that is not right or down', async () => {
    const lone = await ostia(['process', 'run', 'pnpm web', '--split', 'down'])
    expect(lone.code).toBe(1)
    expect(lone.stderr).toContain('--split needs --split-tab')
    const sideways = await ostia([
      'process',
      'run',
      'pnpm web',
      '--split-tab',
      'x',
      '--split',
      'up',
    ])
    expect(sideways.code).toBe(1)
    expect(sideways.stderr).toContain("--split expects right or down, got 'up'")
    const agentSide = await ostia(['agent', 'run', 'claude', '--split', 'down', 'hi'])
    expect(agentSide.code).toBe(1)
    expect(opened).toHaveLength(0)
  })

  it('run: the socket refuses a split tab name with control characters', async () => {
    const res = await ostia(['process', 'run', 'pnpm web', '--split-tab', 'a\u0007b'])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('splitTab')
    expect(opened).toHaveLength(0)
  })

  it('run: starts in the folder the caller is in', async () => {
    await ostia(['process', 'run', 'pnpm dev'], join(home, 'api'))
    expect(opened[0]).toMatchObject({ cwd: join(home, 'api'), title: 'pnpm' })
  })

  it('agent run: starts the agent in a tab with the prompt quoted, and refuses an unknown one', async () => {
    const started = await ostia(['agent', 'run', 'claude', '--name', 'fixer', "fix it; don't stop"])
    expect(started.code).toBe(0)
    expect(JSON.parse(started.stdout)).toMatchObject({ name: 'fixer', paneId: expect.any(String) })
    expect(opened.at(-1)).toMatchObject({
      command: "claude 'fix it; don'\\''t stop'",
      title: 'fixer',
      backgroundTab: true,
    })

    const count = opened.length
    const unknown = await ostia(['agent', 'run', 'aider', 'hello'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('unknown-agent')
    expect((await ostia(['agent', 'run', 'claude'])).stderr).toContain('usage: ostia agent run')
    expect(opened).toHaveLength(count)
  })

  it('run: needs a command', async () => {
    const res = await ostia(['process', 'run'])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('missing "<cmd>"')
  })

  it('ls: prints each process with its status as the pane reports it', async () => {
    expect((await ostia(['process', 'ls'])).stdout.trim()).toBe('(no tracked processes)')
    const { id, tab } = await run('make build', '--name', 'build')
    const line = async (): Promise<string[]> =>
      (await ostia(['process', 'ls'])).stdout.trim().split('\t')

    expect(await line()).toEqual([id, 'build', 'starting', expect.any(String), 'make build'])
    emit(tab, `${PROMPT}make build\r\n${C}compiling\r\n`)
    expect((await line())[2]).toBe('running')
    emit(tab, `${exit(2)}${PROMPT}`)
    expect((await line())[2]).toBe('exited(2)')
  })

  it('logs: prints only that command’s output and resumes from the printed cursor', async () => {
    const { tab } = await run('pnpm test', '--name', 'test')
    emit(tab, `before\r\n${PROMPT}pnpm test\r\n${C}\x1b[32mone\x1b[0m\r\n`)

    const first = await ostia(['process', 'logs', 'test'])
    expect(first.code).toBe(0)
    expect(first.stdout).toBe('one\n')
    const cursor = /^\(cursor=(\d+)\)$/.exec(first.stderr.trim())?.[1]
    expect(cursor).toBeDefined()

    emit(tab, `two\r\n${exit(0)}${PROMPT}echo later\r\n${C}later\r\n`)
    const second = await ostia(['process', 'logs', 'test', '--since', String(cursor)])
    expect(second.stdout).toBe('two\n')
  })

  it('logs: fails on an unknown process', async () => {
    const res = await ostia(['process', 'logs', 'nope'])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('process logs failed (not-found)')
  })

  it('kill: interrupts the command and ls shows it exited', async () => {
    const { tab } = await run('sleep 30', '--name', 'nap')
    emit(tab, `${PROMPT}sleep 30\r\n${C}`)

    const res = await ostia(['process', 'kill', 'nap'])
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('ok')
    expect(written).toEqual([{ paneId: tab, data: '\x03' }])
    expect((await ostia(['process', 'ls'])).stdout).toContain('exited(130)')
  })

  it('restart: runs the same line again in the same tab', async () => {
    const { id, tab } = await run(`node app.js --name 'my app'`, '--name', 'app')
    emit(tab, `${PROMPT}node app.js\r\n${C}up\r\n`)

    const res = await ostia(['process', 'restart', 'app'])
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout)).toMatchObject({ id, name: 'app' })
    expect(reruns).toEqual([{ paneId: tab, command: `node app.js --name 'my app'` }])
    expect(opened).toHaveLength(1)
  })
})

describe('ostia pane (the real CLI against a live control server)', () => {
  it('send and key: type into a tab the caller opened, addressed by process name', async () => {
    const { tab } = await run('cat', '--name', 'echo')

    const send = await ostia(['pane', 'send', 'echo', 'hello', 'world', '--enter'])
    expect(send.stderr).toBe('')
    expect(send.stdout.trim()).toBe('ok')
    const key = await ostia(['pane', 'key', 'echo', 'ctrl-d'])
    expect(key.code).toBe(0)

    expect(written).toEqual([
      { paneId: tab, data: 'hello world' },
      { paneId: tab, data: '\r' },
      { paneId: tab, data: '\x04' },
    ])
    expect(request).not.toHaveBeenCalled()
  })

  it('read: prints the screen, and the pane state with --json', async () => {
    const { tab } = await run('cat', '--name', 'echo')
    const text = await ostia(['pane', 'read', 'echo', '--lines', '20'])
    expect(text.stdout.trim()).toBe(`screen of ${tab} (20)`)

    const json = JSON.parse((await ostia(['pane', 'read', 'echo', '--json'])).stdout)
    expect(json).toMatchObject({ text: `screen of ${tab} (200)`, cwd: '/w', running: true })
  })

  it('send: asks the human for a pane the caller did not open and fails when denied', async () => {
    const res = await ostia(['pane', 'send', other.externalId, 'rm -rf .', '--enter'])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('denied: type-other-pane')
    expect(request).toHaveBeenCalledTimes(1)
    expect(written).toEqual([])
  })

  it('read: asks the human for a pane the caller did not open and reads once allowed', async () => {
    const denied = await ostia(['pane', 'read', other.externalId])
    expect(denied.code).toBe(1)
    expect(denied.stderr).toContain('denied: read-other-pane')

    answer = 'once'
    const allowed = await ostia(['pane', 'read', other.externalId])
    expect(allowed.code).toBe(0)
    expect(allowed.stdout.trim()).toBe('screen of other-pane (200)')
  })

  it('close: closes a tab the caller opened by process name without asking', async () => {
    const { tab } = await run('sleep 30', '--name', 'sleeper')
    const res = await ostia(['pane', 'close', 'sleeper'])
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe(getByPaneId(tab)?.externalId)
    expect(closedPanes).toEqual([tab])
    expect(request).not.toHaveBeenCalled()
  })

  it('close: asks for kill-pane for another pane and answers unknown-pane for an unknown name', async () => {
    const denied = await ostia(['pane', 'close', other.externalId])
    expect(denied.code).toBe(1)
    expect(denied.stderr).toContain('denied: kill-pane')
    const unknown = await ostia(['pane', 'close', 'nobody'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('unknown-pane: nobody')
    expect(closedPanes).toEqual([])
  })

  it('prints usage for a missing pane or an unknown key', async () => {
    const usage = await ostia(['pane', 'send'])
    expect(usage.code).toBe(1)
    expect(usage.stderr).toContain('usage: ostia pane send')

    await run('cat', '--name', 'echo')
    const key = await ostia(['pane', 'key', 'echo', 'f13'])
    expect(key.code).toBe(1)
    expect(key.stderr).toContain('unknown-key: f13')
  })
})
