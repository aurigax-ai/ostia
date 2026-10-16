import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalOutcome } from '../shared/permissions/approvals'
import type { CommandDescriptor, CommandResult, CommandTarget } from '../shared/control/commands'

let answer: ApprovalOutcome = 'deny'
const request = vi.fn(async () => answer)

vi.mock('../main/approvals/approvals', () => ({ approvals: () => ({ request }) }))

const { registerControlServer, stopControlServer } = await import('../main/control/controlServer')
const { getByPaneId, registerPane } = await import('../main/control/idRegistry')
const { registerPaneIoMethods } = await import('../main/panes/paneIo')
const { registerPaneResumeMethods } = await import('../main/panes/paneResume')
const { PaneWaking } = await import('../main/panes/paneWaking')
const { registerProcessMethods } = await import('../main/panes/processManager')
const { approvals } = await import('../main/approvals/approvals')
const { createReach } = await import('../main/approvals/reach')
const { listWorkspaceGroups, listWorkspaces, registerPaneListMethods } = await import(
  '../main/panes/paneList'
)
const { emptyWorkspaceSandbox } = await import('../shared/sandbox/sandbox')
const { PtyRingBuffer } = await import('../main/terminal/ptyRingBuffer')

type OpenRequest = Parameters<Parameters<typeof registerProcessMethods>[0]['openTab']>[0]

const cliPath = join(process.cwd(), 'out', 'cli', 'index.js')
const PROMPT = '\x1b]133;A\x1b\\% \x1b]133;B\x1b\\'
const C = '\x1b]133;C\x1b\\'
const exit = (code: number): string => `\x1b]133;D;${code}\x1b\\`
const startsRunning = (paneId: string, command: string): void =>
  emit(paneId, `${PROMPT}${command}\r\n${C}`)
let onOpen: (paneId: string, command: string) => void = startsRunning
let hooked = false
const hiddenWorkspaces = new Set<string>()

const rings = new Map<string, InstanceType<typeof PtyRingBuffer>>()
const opened: OpenRequest[] = []
const written: { paneId: string; data: string }[] = []
const reruns: { paneId: string; command: string }[] = []
const closedPanes: string[] = []
const newWorkspaceArgs: unknown[] = []
const asleep = new Set<string>()
const waking = new PaneWaking()
let tabSeq = 0

type WorkspaceRow = Awaited<ReturnType<typeof listWorkspaces>>[number]
let workspaces: WorkspaceRow[] = []

const COMMANDS = [
  { id: 'workspace.new', capabilities: [] as string[] },
  { id: 'workspace.setFolder', capabilities: ['drive-self'] },
].map((c) => ({
  ...c,
  title: c.id,
  category: null,
  hidden: false,
  argsSchema: null,
})) as unknown as CommandDescriptor[]

async function execRenderer(
  target: CommandTarget,
  id: string,
  args?: unknown,
): Promise<CommandResult> {
  const given = (args ?? {}) as { dir?: string; name?: string }
  if (id === 'pane.list')
    return {
      ok: true,
      result: [...rings.keys()].map((paneId) => ({
        paneId,
        workspaceId: 'ws1',
        kind: 'terminal',
        title: paneId,
        cwd: '/w',
      })),
    }
  if (id === 'workspace.list') {
    return { ok: true, result: workspaces.filter((w) => !hiddenWorkspaces.has(w.workspaceId)) }
  }
  if (id === 'workspace.groups') return { ok: true, result: [] }
  if (id === 'workspace.new') {
    newWorkspaceArgs.push(args)
    const workspaceId = `ws${workspaces.length + 1}`
    workspaces.push({
      workspaceId,
      name: given.name ?? '',
      kind: 'terminal',
      workDir: given.dir ?? '',
      state: 'idle',
    })
    return { ok: true, result: { workspaceId } }
  }
  if (id === 'workspace.setFolder') {
    const row = workspaces.find((w) => w.workspaceId === target.workspaceId)
    if (row) row.workDir = given.dir ?? row.workDir
  }
  return { ok: true } as CommandResult
}

const windows = { execCommand: execRenderer, windowIds: () => ['w1'] }
registerPaneListMethods({
  ...windows,
  getTerminalState: () => undefined,
  ptyPid: () => undefined,
  waking: (paneId) => waking.has(paneId),
})

const reach = createReach({
  mode: () => 'project',
  home: '/nonexistent-home',
  workDir: (workspaceId) => workspaces.find((w) => w.workspaceId === workspaceId)?.workDir,
  isScratch: () => false,
  hasManager: () => false,
  sandbox: () => emptyWorkspaceSandbox(),
  workspaces: async () => {
    const [listed, groups] = await Promise.all([
      listWorkspaces(windows),
      listWorkspaceGroups(windows),
    ])
    return { workspaces: listed, groups }
  },
  ask: (ask) => approvals()?.request(ask) ?? null,
  agentGroupsChanged: () => {},
})
const registry = registerProcessMethods({
  isSandboxed: () => false,
  reach,
  openTab: async (req) => {
    opened.push(req)
    tabSeq += 1
    const paneId = `tab-${tabSeq}`
    rings.set(paneId, new PtyRingBuffer())
    const id = registerPane({
      windowId: 'w1',
      workspaceId: req.workspaceId ?? '',
      paneId,
    }).externalId
    const opening = onOpen
    setTimeout(() => opening(paneId, req.command), 0)
    return id
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
  isAgent: () => false,
  paneTitle: async () => undefined,
  splitTabNow: async () => null,
  humanTab: async () => false,
  agentStarted: () => false,
  startsWithHook: () => hooked,
  agentChanges: () => () => {},
  tell: () => {},
  startTiming: { settleMs: 10, processMs: 60, agentMs: 60, pollMs: 5 },
  agentArgv: (name) => (name === 'claude' ? ['claude'] : null),
  interruptGraceMs: 50,
})

registerPaneIoMethods({
  io: {
    read: async (paneId, lines) => `screen of ${paneId} (${lines})`,
    write: (paneId, data) => {
      written.push({ paneId, data })
      rings.get(paneId)?.push(data)
      return true
    },
    bracketedPaste: () => false,
    outputCursor: (paneId) => rings.get(paneId)?.end,
  },
  state: (paneId) => ({ paneId, generation: 1, cwd: '/w', running: true, blockCount: 1 }),
  processPane: async (ref, ctx) => {
    const entry = registry.resolve(ref, ctx.identity.workspaceId, await reach.visible(ctx))
    return entry && entry.status !== 'closed' ? entry.paneId : undefined
  },
  inScope: reach.inScope,
  isChild: (ownerPaneId, paneId) => registry.isChild(ownerPaneId, paneId),
  isSandboxed: () => false,
  isConfined: () => false,
  managerAllowsInput: () => false,
  attention: async () => ({}),
  inputSent: () => {},
  hibernated: async (pane) => asleep.has(pane.paneId),
  wake: async (pane) => ({ woke: asleep.delete(pane.paneId) }),
  hibernate: async () => ({ ok: true, result: { hibernated: true, outcome: 'hibernated' } }),
  panes: async () => [],
  waking,
  close: async (pane) => {
    closedPanes.push(pane.paneId)
    return { ok: true, result: undefined }
  },
  resume: async () => ({ ok: true, result: { resumed: true } }),
  delay: async () => {},
  hooksOn: () => false,
})

registerPaneResumeMethods({
  execCommand: async () => ({ ok: true }) as CommandResult,
  foregroundProgram: () => null,
  agentCwd: async () => null,
  onResume: (identity) => waking.end(identity.paneId, 'started'),
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

function ostia(
  args: string[],
  cwd = home,
  token = agent.token,
  input?: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, OSTIA_SOCKET: socketPath, OSTIA_TOKEN: token },
    })
    liveChildren.add(child)
    child.stdin?.end(input ?? '')
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
  const status = JSON.parse(res.stdout).status
  if (status === 'started') expect(res.stderr).toBe('')
  else expect(res.stderr).toContain('ostia process run: ')
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
      execCommand: execRenderer,
      listCommandsFor: () => COMMANDS,
      getTerminalState: () => undefined,
      isSandboxed: () => false,
      byAgent: reach.byAgent,
    },
    socketPath,
  )
  workspaces = [{ workspaceId: 'ws1', name: 'ws1', kind: 'terminal', workDir: home, state: 'idle' }]
  answer = 'deny'
  request.mockClear()
  opened.length = 0
  written.length = 0
  reruns.length = 0
  closedPanes.length = 0
  asleep.clear()
})

afterEach(() => {
  hooked = false
  onOpen = startsRunning
  stopControlServer()
  for (const w of workspaces) {
    registry.workspaceClosed(w.workspaceId)
    reach.forget(w.workspaceId)
  }
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
    expect(started).toMatchObject({ status: 'started' })
    expect(Object.keys(started).sort()).toEqual(['id', 'name', 'paneId', 'status'])
  })

  it('agent run: refuses an unknown flag before opening anything, never passing it to the agent', async () => {
    const res = await ostia(['agent', 'run', 'claude', '--split-tab', 'workers', 'fix it'])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('unknown flag --split-tab')
    expect(opened).toEqual([])
  })

  it('agent run: --model reaches the agent as argv, with the prompt read from stdin', async () => {
    const spaced = await ostia(
      ['agent', 'run', 'claude', '--name', 'W', '--model', 'sonnet', '-'],
      home,
      agent.token,
      'the brief; $(not run)',
    )
    expect(spaced.stderr).toBe('')
    expect(opened.at(-1)?.command).toBe("claude --model sonnet 'the brief; $(not run)'")

    const joined = await ostia(
      ['agent', 'run', 'claude', '--model=sonnet', '-'],
      home,
      agent.token,
      'second brief',
    )
    expect(joined.stderr).toBe('')
    expect(opened.at(-1)?.command).toBe("claude --model sonnet 'second brief'")
  })

  it('agent run: - reads the prompt from stdin whatever flags come before or after it', async () => {
    const before = await ostia(
      ['agent', 'run', 'claude', '--name', 'W', '--cwd', 'api', '--tab', 'workers', '-'],
      home,
      agent.token,
      'brief one',
    )
    expect(before.stderr).toBe('')
    expect(opened.at(-1)).toMatchObject({
      command: "claude 'brief one'",
      title: 'W',
      cwd: join(home, 'api'),
      splitTab: { name: 'workers' },
    })

    const after = await ostia(
      ['agent', 'run', 'claude', '-', '--name', 'W2'],
      home,
      agent.token,
      'brief two',
    )
    expect(after.stderr).toBe('')
    expect(opened.at(-1)).toMatchObject({ command: "claude 'brief two'", title: 'W2' })
  })

  it('agent run: an agent that exits 0 at once is still a failure, never started', async () => {
    hooked = true
    onOpen = (paneId, command) => emit(paneId, `${PROMPT}${command}\r\n${C}${exit(0)}${PROMPT}`)
    const res = await ostia(['agent', 'run', 'claude', '--model', 'sonnet', 'fix it'])
    expect(res.code).toBe(1)
    expect(JSON.parse(res.stdout)).toMatchObject({ status: 'failed', exitCode: 0 })
    expect(res.stderr).toContain('before the agent started')
  })

  it('agent run: refuses an unknown flag or a model outside the allow-list with the usage, starting nothing', async () => {
    const bogus = await ostia(['agent', 'run', 'claude', '--bogus', 'x', 'fix it'])
    expect(bogus.code).toBe(1)
    expect(bogus.stderr).toContain('unknown flag --bogus')
    expect(bogus.stderr).toContain('ostia agent run <agent>')

    const dashed = await ostia(['agent', 'run', 'claude', '--model', '--yolo', 'fix it'])
    expect(dashed.code).toBe(1)
    expect(opened).toEqual([])
  })

  it('agent run: an agent whose command exits at once is reported failed with its code and output', async () => {
    onOpen = (paneId, command) =>
      emit(paneId, `${PROMPT}${command}\r\n${C}error: unknown option '--x'\r\n${exit(1)}${PROMPT}`)
    const res = await ostia(['agent', 'run', 'claude', '--name', 'lead', 'fix it'])
    expect(res.code).toBe(1)
    expect(JSON.parse(res.stdout)).toMatchObject({
      name: 'lead',
      status: 'failed',
      exitCode: 1,
      output: ["error: unknown option '--x'"],
    })
    expect(res.stderr).toContain('ostia agent run: lead (')
    expect(res.stderr).toContain('failed')
  })

  it('workspace new: passes its name, group and --no-focus, answers with the workspace it read back, and fails when it is not there', async () => {
    const made = await ostia(['workspace', 'new', home, '--name', 'made', '--no-focus'])
    expect(made.code).toBe(0)
    const { workspaceId } = JSON.parse(made.stdout)
    expect(workspaces.map((w) => w.workspaceId)).toContain(workspaceId)
    const grouped = await ostia([
      'workspace',
      'new',
      home,
      '--name',
      'proj · workers',
      '--group',
      'proj',
      '--no-focus',
    ])
    expect(grouped.code).toBe(0)
    expect(newWorkspaceArgs.at(-1)).toEqual({
      dir: home,
      name: 'proj · workers',
      group: 'proj',
      focus: false,
    })
    hiddenWorkspaces.add(`ws${workspaces.length + 1}`)
    const lost = await ostia(['workspace', 'new', home, '--name', 'lost', '--no-focus'])
    expect(lost.code).toBe(1)
    expect(lost.stderr).toContain('is not in the workspace list')
    hiddenWorkspaces.clear()
  }, 15_000)

  it('run --tab: passes the split tab name, and has no side flag', async () => {
    const first = await ostia(['process', 'run', 'pnpm web', '--tab', 'dev'])
    expect(first.stderr).toBe('')
    expect(opened[0]).toMatchObject({ backgroundTab: true, splitTab: { name: 'dev' } })

    await ostia(['agent', 'run', 'claude', '--tab', 'dev', 'watch the logs'])
    expect(opened[1].splitTab).toEqual({ name: 'dev' })

    const side = await ostia(['process', 'run', 'pnpm api', '--tab', 'dev', '--split', 'down'])
    expect(side.code).toBe(1)
    expect(side.stderr).toContain('unknown flag --split')
    const old = await ostia(['process', 'run', 'pnpm api', '--split-tab', 'dev'])
    expect(old.code).toBe(1)
    expect(old.stderr).toContain('unknown flag --split-tab')
    expect(opened).toHaveLength(2)
  })

  it('run: the socket refuses a split tab name with control characters', async () => {
    const res = await ostia(['process', 'run', 'pnpm web', '--tab', 'a\u0007b'])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('bad-request: tab')
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
    expect((await ostia(['agent', 'run', 'claude'])).stderr).toContain('ostia agent run <agent>')
    expect(opened).toHaveLength(count)
  })

  it('an agent starts a worker in a workspace of its own project without asking, and asks for another project or one it moved its folder into', async () => {
    const main = join(home, 'proj')
    const worktree = join(home, 'proj-workers')
    const gitDir = join(main, '.git', 'worktrees', 'proj-workers')
    mkdirSync(gitDir, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(gitDir, 'commondir'), '../..\n')
    writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`)
    const elsewhere = join(home, 'other')
    mkdirSync(join(elsewhere, '.git'), { recursive: true })
    workspaces[0].workDir = main

    expect(
      (await ostia(['workspace', 'new', worktree, '--name', 'proj workers', '--no-focus'])).code,
    ).toBe(0)
    const fixer = await ostia([
      'agent',
      'run',
      'claude',
      'fix the login bug',
      '--name',
      'fixer',
      '--workspace',
      'proj workers',
    ])
    expect(fixer.stderr).toBe('')
    expect(fixer.code).toBe(0)
    expect(JSON.parse(fixer.stdout)).toMatchObject({ name: 'fixer' })
    expect(opened.at(-1)).toMatchObject({ workspaceId: 'ws2', title: 'fixer' })
    expect(request).not.toHaveBeenCalled()
    emit(`tab-${tabSeq}`, `${PROMPT}claude 'fix the login bug'\r\n${C}`)
    expect((await ostia(['process', 'list'])).stdout).toMatch(/fixer\s+running/)

    const count = opened.length
    expect(
      (await ostia(['workspace', 'new', elsewhere, '--name', 'other', '--no-focus'])).code,
    ).toBe(0)
    const stranger = await ostia([
      'agent',
      'run',
      'claude',
      'look around',
      '--name',
      'stranger',
      '--workspace',
      'other',
    ])
    expect(stranger.code).toBe(1)
    expect(stranger.stderr).toContain('denied: all-workspaces')
    expect(stranger.stderr).toContain('act on other panes and workspaces')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ caps: ['all-workspaces'] }))

    request.mockClear()
    expect((await ostia(['workspace', 'dir', elsewhere])).code).toBe(0)
    const drifter = await ostia([
      'agent',
      'run',
      'claude',
      'look again',
      '--name',
      'drifter',
      '--workspace',
      'other',
    ])
    expect(drifter.code).toBe(1)
    expect(drifter.stderr).toContain('denied: all-workspaces')
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: 'reach-project', subject: elsewhere, caps: [] }),
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ caps: ['all-workspaces'] }),
    )
    expect(opened).toHaveLength(count)
  })

  it('run: needs a command', async () => {
    const res = await ostia(['process', 'run'])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('ostia process run "<cmd>"')
  })

  it('list: prints each process with its status as the pane reports it', async () => {
    onOpen = () => {}
    expect((await ostia(['process', 'list'])).stdout.trim()).toBe('(no tracked processes)')
    const { id, tab } = await run('make build', '--name', 'build')
    const line = async (): Promise<string[]> =>
      (await ostia(['process', 'list'])).stdout.trim().split('\t')

    expect(await line()).toEqual([id, 'build', 'starting', expect.any(String), 'make build'])
    emit(tab, `${PROMPT}make build\r\n${C}compiling\r\n`)
    expect((await line())[2]).toBe('running')
    emit(tab, `${exit(2)}${PROMPT}`)
    expect((await line())[2]).toBe('exited(2)')
  })

  it('logs: prints only that command’s output and resumes from the printed cursor', async () => {
    onOpen = () => {}
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

  it('kill: interrupts the command and list shows it exited', async () => {
    const { tab } = await run('sleep 30', '--name', 'nap')
    emit(tab, `${PROMPT}sleep 30\r\n${C}`)

    const res = await ostia(['process', 'kill', 'nap'])
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('ok')
    expect(written).toEqual([{ paneId: tab, data: '\x03' }])
    expect((await ostia(['process', 'list'])).stdout).toContain('exited(130)')
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

  it('pane wake returns once the woken agent started, and a send before that is refused', async () => {
    const { tab } = await run('claude', '--name', 'fixer')
    const fixer = getByPaneId(tab)
    asleep.add(tab)
    const wakingPanes = async (): Promise<string[]> =>
      JSON.parse((await ostia(['pane', 'list'])).stdout)
        .filter((p: { waking?: true }) => p.waking)
        .map((p: { paneId: string }) => p.paneId)

    const woke = ostia(['pane', 'wake', 'fixer'])
    const beforeStart = await Promise.race([
      woke.then(() => 'returned'),
      new Promise((resolve) => setTimeout(resolve, 1000, 'waiting')),
    ])
    expect(beforeStart).toBe('waiting')
    const early = await ostia(['pane', 'send', 'fixer', 'early', '--enter'])
    expect(early.code).toBe(1)
    expect(early.stderr).toContain(`waking: ${fixer?.externalId} is starting its agent`)
    expect(await wakingPanes()).toEqual([fixer?.externalId])
    const token = await ostia(['resume-token', 'claude', 'e2e-wake-wait'], home, fixer?.token)
    expect(token.stdout.trim()).toBe('ok')
    const done = await woke
    expect(done.code).toBe(0)
    expect(done.stdout.trim()).toBe(fixer?.externalId)

    const sent = await ostia(['pane', 'send', 'fixer', 'hi', '--enter'])
    expect(sent.stdout.trim()).toBe('ok')
    expect(written).toEqual([
      { paneId: tab, data: 'hi' },
      { paneId: tab, data: '\r' },
    ])
    expect(await wakingPanes()).toEqual([])
  })

  it('prints usage for a missing pane or an unknown key', async () => {
    const usage = await ostia(['pane', 'send'])
    expect(usage.code).toBe(1)
    expect(usage.stderr).toContain('ostia pane send <pane>')

    await run('cat', '--name', 'echo')
    const key = await ostia(['pane', 'key', 'echo', 'f13'])
    expect(key.code).toBe(1)
    expect(key.stderr).toContain('unknown-key: f13')
  })
})
