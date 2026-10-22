import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneEntry } from '../main/panes/paneList'
import type { CommandResult, CommandTarget } from '../shared/control/commands'

const dir = mkdtempSync(join(tmpdir(), 'ostia-cli-events-'))
process.env.XDG_DATA_HOME = join(dir, 'data')

const request = vi.fn(async () => 'once' as const)
vi.mock('../main/approvals/approvals', () => ({ approvals: () => ({ request }) }))

const { registerAttentionMethods } = await import('../main/attention/attention')
const { registerBusMethods } = await import('../main/agents/busMethods')
const { flushBus, resetBus } = await import('../main/agents/busStore')
const { ReportedAgentWork, registerAgentWorkMethods } = await import('../main/agents/agentWork')
const { registerControlServer, stopControlServer } = await import('../main/control/controlServer')
const { getByPaneId, registerPane } = await import('../main/control/idRegistry')
const { PaneEvents } = await import('../main/panes/paneEvents')
const { PaneJournal } = await import('../main/panes/paneJournal')
const { collectStatus, registerPaneStatusMethods } = await import('../main/panes/paneStatus')
const { PaneWatch, registerPaneWaitMethods } = await import('../main/panes/paneWait')
const { registerPaneWatchMethods } = await import('../main/panes/paneWatchMethods')
const { statusLine } = await import('../shared/panes/paneStatus')

const cliPath = join(process.cwd(), 'out', 'cli', 'index.js')
const socketPath = join(dir, 'control.sock')

const boss = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'cli-ev-boss' })
const worker = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'cli-ev-worker' })

const attention = new Map<string, { state?: string; message?: string }>()
const terminals = new Map<string, { running: boolean; blockCount: number; lastExitCode?: number }>()
const paneWatch = new PaneWatch()
const journal = new PaneJournal({ terminal: (id) => terminals.get(id), now: Date.now })
paneWatch.tap(journal.onChange)

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function run(pane: typeof worker, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: dir,
        OSTIA_SOCKET: socketPath,
        OSTIA_TOKEN: pane.token,
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

const entries = (): PaneEntry[] => [
  {
    paneId: worker.externalId,
    workspaceId: 'ws1',
    kind: 'terminal',
    title: 'w-1',
    running: terminals.get(worker.paneId)?.running ?? false,
    blockCount: terminals.get(worker.paneId)?.blockCount ?? 0,
    lastExitCode: terminals.get(worker.paneId)?.lastExitCode,
    agent: 'claude',
    agentState: attention.get(worker.paneId)?.state,
  } as PaneEntry,
]

beforeAll(() => {
  const reach = {
    processPane: async () => [],
    visible: async () => () => true,
    inScope: async () => true,
    isChild: () => false,
    isSandboxed: () => false,
    isConfined: () => false,
  }
  const statusDeps = {
    ...reach,
    panes: async () => entries(),
    journal,
    wakingSince: () => undefined,
    conflicts: () => [],
    exited: () => false,
    git: async () => undefined,
    now: Date.now,
  }
  const execCommand = async (target: CommandTarget, id: string, args?: unknown) => {
    if (id === 'attention.set' && target.paneId) {
      const { state, message } = args as { state: string; message?: string }
      const next = state === 'none' ? undefined : state
      attention.set(target.paneId, { state: next, message })
      paneWatch.attention(target.paneId, next ?? 'none', message)
    }
    return { ok: true } as CommandResult
  }
  registerAgentWorkMethods(new ReportedAgentWork())
  registerAttentionMethods({
    execCommand,
    closing: (paneId, state, message, stop) => journal.report(paneId, state, message, stop),
  })
  registerBusMethods({
    hibernated: () => false,
    managerSendAllowed: () => true,
    agentBusy: () => false,
    announce: () => {},
    pending: async () => 'idle-no-wake',
    reach,
  })
  registerPaneStatusMethods(statusDeps)
  registerPaneWaitMethods({
    ...reach,
    watch: paneWatch,
    attention: async (pane) => attention.get(pane.paneId) ?? {},
    exited: () => false,
    terminal: (paneId) => terminals.get(paneId),
    status: async (to, caller) => collectStatus(statusDeps, to, caller, entries()),
  })
  const events = new PaneEvents({
    identity: getByPaneId,
    exited: () => false,
    line: async (watched, subscriber) => {
      const status = await collectStatus(statusDeps, watched, subscriber.externalId, entries())
      return status ? statusLine(status) : undefined
    },
  })
  journal.subscribe(events.onJournal)
  paneWatch.tap(events.onChange)
  registerPaneWatchMethods(reach)
  registerControlServer(
    {
      execCommand,
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
  attention.clear()
  terminals.clear()
  journal.forget(worker.paneId, boss.externalId)
})

afterAll(async () => {
  stopControlServer()
  await flushBus()
  rmSync(dir, { recursive: true, force: true })
})

describe('pane events through the real CLI', () => {
  it('delivers one event line to the coordinator’s bus wait when a watched worker finishes', async () => {
    const watching = await run(boss, ['pane', 'watch', worker.externalId, '--until', 'done'])
    expect(watching.code).toBe(0)
    expect(watching.stdout).toContain(`${worker.externalId.slice(0, 8)}\tuntil done`)

    const waiting = run(boss, ['bus', 'wait', '--timeout', '30', '--json'])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await run(worker, ['state', 'working'])
    await run(worker, ['state', 'done', 'PR #1104 open, unit green'])
    const woken = JSON.parse((await waiting).stdout)
    expect(woken.timedOut).toBe(false)
    expect(woken.messages).toHaveLength(1)
    expect(woken.messages[0]).toMatchObject({ kind: 'event', from: worker.externalId })
    expect(woken.messages[0].text).toContain('w-1  done')
    expect(woken.messages[0].text).toContain('"PR #1104 open, unit green"')
  }, 60_000)

  it('queues the event while the coordinator is busy, once, and stops after --off', async () => {
    await run(boss, ['pane', 'watch', worker.externalId])
    await run(worker, ['state', 'done', 'first report'])
    await run(worker, ['state', 'working'])
    await run(worker, ['state', 'done', 'second report'])
    await new Promise((resolve) => setTimeout(resolve, 300))
    const inbox = JSON.parse((await run(boss, ['bus', 'inbox', '--json'])).stdout)
    expect(inbox).toHaveLength(1)
    expect(inbox[0].kind).toBe('event')

    const off = await run(boss, ['pane', 'watch', worker.externalId, '--off'])
    expect(off.stderr).toContain('(watching nothing)')
    await run(boss, ['bus', 'inbox', '--take'])
    await run(worker, ['state', 'working'])
    await run(worker, ['state', 'done'])
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(JSON.parse((await run(boss, ['bus', 'inbox', '--json'])).stdout)).toEqual([])
  }, 60_000)

  it('pane wait --until command prints the status line with the exit code', async () => {
    terminals.set(worker.paneId, { running: true, blockCount: 1 })
    const waiting = run(boss, [
      'pane',
      'wait',
      worker.externalId,
      '--until',
      'command',
      '--timeout',
      '30',
    ])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    paneWatch.emit(worker.paneId, { kind: 'state' })
    terminals.set(worker.paneId, { running: false, blockCount: 2, lastExitCode: 3 })
    paneWatch.emit(worker.paneId, { kind: 'state' })
    const res = await waiting
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('w-1')
    expect(res.stdout).toContain('exit 3')
  }, 60_000)

  it('pane wait --until error returns when the agent reports an error', async () => {
    const waiting = run(boss, ['pane', 'wait', worker.externalId, '--until', 'error', '--json'])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await run(worker, ['state', 'error', 'Turn failed'])
    const res = JSON.parse((await waiting).stdout)
    expect(res).toMatchObject({ paneId: worker.externalId, state: 'error', message: 'Turn failed' })
    expect(res.status.title).toBe('w-1')
  }, 60_000)
})
