import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PaneEntry } from '../main/panes/paneList'
import type { CommandResult, CommandTarget } from '../shared/control/commands'

const dir = mkdtempSync(join(tmpdir(), 'ostia-cli-status-'))
process.env.XDG_DATA_HOME = join(dir, 'data')

const request = vi.fn(async () => 'once' as const)
vi.mock('../main/approvals/approvals', () => ({ approvals: () => ({ request }) }))

const { ReportedAgentWork, registerAgentWorkMethods } = await import('../main/agents/agentWork')
const { registerAttentionMethods } = await import('../main/attention/attention')
const { registerControlServer, stopControlServer } = await import('../main/control/controlServer')
const { registerPane } = await import('../main/control/idRegistry')
const { PaneJournal } = await import('../main/panes/paneJournal')
const { registerPaneStatusMethods } = await import('../main/panes/paneStatus')

const cliPath = join(process.cwd(), 'out', 'cli', 'index.js')
const socketPath = join(dir, 'control.sock')

const coordinator = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'cli-st-boss' })
const worker = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'cli-st-worker' })

const attention = new Map<string, { state?: string }>()
const journal = new PaneJournal({ terminal: () => undefined, now: Date.now })
const agentCalls = vi.fn()

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function run(pane: typeof worker, args: string[], input = ''): Promise<RunResult> {
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
    }, 30_000)
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
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

const status = (...flags: string[]) =>
  run(coordinator, ['pane', 'status', worker.externalId, ...flags])

beforeAll(() => {
  const execCommand = async (
    target: CommandTarget,
    id: string,
    args?: unknown,
  ): Promise<CommandResult> => {
    if (id === 'attention.set' && target.paneId) {
      const { state } = args as { state: string }
      const next = state === 'none' ? undefined : state
      attention.set(target.paneId, { state: next })
      journal.onChange(target.paneId, { kind: 'attention', attention: { state: next } })
    }
    return { ok: true } as CommandResult
  }
  registerAgentWorkMethods(new ReportedAgentWork())
  registerAttentionMethods({
    execCommand,
    closing: (paneId, state, message, stop) => journal.report(paneId, state, message, stop),
  })
  registerPaneStatusMethods({
    processPane: async () => [],
    visible: async () => () => true,
    inScope: async () => true,
    isChild: (owner, paneId) => owner === coordinator.paneId && paneId === worker.paneId,
    isSandboxed: () => false,
    isConfined: () => false,
    panes: async () => [
      {
        paneId: worker.externalId,
        workspaceId: 'ws1',
        kind: 'terminal',
        title: 'w-3',
        running: false,
        blockCount: 0,
        agent: 'claude',
        agentState: attention.get(worker.paneId)?.state,
        lastExitCode: 0,
      } as PaneEntry,
    ],
    journal,
    exited: () => false,
    git: async () => ({ branch: 'feat/inbox', ahead: 1, behind: 0, changed: 2 }),
    wakingSince: () => undefined,
    conflicts: () => [],
    now: Date.now,
  })
  registerControlServer(
    {
      execCommand,
      listCommandsFor: () => [],
      getTerminalState: () => undefined,
      isSandboxed: () => false,
      journal: { call: agentCalls },
    },
    socketPath,
  )
})

afterAll(() => {
  stopControlServer()
  rmSync(dir, { recursive: true, force: true })
})

describe('ostia pane status through the real CLI', () => {
  it('shows a worker’s closing line, exit code and changes, and only what is new on the next look', async () => {
    const first = await status()
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('w-3  idle')
    expect(first.stdout).toContain('(first look)')

    expect((await run(worker, ['state', 'working'])).code).toBe(0)
    const stop = JSON.stringify({
      session_id: 's-1',
      hook_event_name: 'Stop',
      last_assistant_message: 'PR #1104 open, unit green.\nSecond paragraph of the report.',
    })
    const hook = await run(worker, ['claude-hook', 'Stop'], stop)
    expect(hook).toMatchObject({ code: 0, stderr: '' })

    const second = await status()
    expect(second.stdout).toMatch(
      new RegExp(
        `^${worker.externalId.slice(0, 8)} {2}w-3 {2}done \\d+s {2}exit 0 {2}feat/inbox \\+2 ↑1 {2}mail 0`,
      ),
    )
    expect(second.stdout).toContain('"PR #1104 open, unit green."')
    expect(second.stdout).toContain('since last: working→done, new closing line')
    expect(second.stdout).not.toContain('Second paragraph')
    expect(second.stdout.trim().split('\n')).toHaveLength(1)

    expect((await status()).stdout).toContain('(no change since last)')
  }, 60_000)

  it('prefers the closing line the agent set over the Stop text, and takes Codex’s from --stop', async () => {
    const stop = JSON.stringify({ session_id: 's-1', last_assistant_message: 'stop text' })
    await run(worker, ['state', 'working'])
    await run(worker, ['state', 'done', 'PR #5 merged'])
    await run(worker, ['claude-hook', 'Stop'], stop)
    const explicit = JSON.parse((await status('--json')).stdout)
    expect(explicit.panes[0]).toMatchObject({ state: 'done', closing: 'PR #5 merged' })

    await run(worker, ['state', 'working'])
    expect((await run(worker, ['state', 'done', '--stop'], stop)).code).toBe(0)
    const codex = JSON.parse((await status('--json')).stdout)
    expect(codex.panes[0]).toMatchObject({ state: 'done', closing: 'stop text' })
    expect(codex.panes[0].changes).toMatchObject({ first: false, closing: true })
  }, 60_000)

  it('journals each call by method, caller, outcome code and size, and nothing the call carried', async () => {
    agentCalls.mockClear()
    await run(worker, ['state', 'done', 'PR #7 merged, secret-closing-line'])
    await status()
    await run(coordinator, ['pane', 'status', 'not-a-pane'])
    const calls = agentCalls.mock.calls.map(([call]) => call)
    expect(calls.map((c) => [c.method, c.caller, c.code])).toEqual([
      ['pane.setAttention', 'pane', undefined],
      ['pane.status', 'pane', undefined],
      ['pane.status', 'pane', 'unknown-pane'],
    ])
    expect(calls[1].bytes).toBeGreaterThan(100)
    expect(calls[1].ms).toBeGreaterThanOrEqual(0)
    const written = JSON.stringify(calls)
    expect(written).not.toContain('secret-closing-line')
    expect(written).not.toContain(worker.externalId)
  }, 60_000)

  it('takes the first 8 characters of an id and starts each line with them', async () => {
    const res = await run(coordinator, ['pane', 'status', worker.externalId.slice(0, 8)])
    expect(res.code).toBe(0)
    expect(res.stdout.startsWith(`${worker.externalId.slice(0, 8)}  w-3  `)).toBe(true)
  }, 30_000)

  it('answers the other terminals of the caller’s workspace when it names no pane', async () => {
    const res = await run(coordinator, ['pane', 'status'])
    expect(res.code).toBe(0)
    expect(res.stdout.trim().split('\n')).toHaveLength(1)
    expect(res.stdout.startsWith(`${worker.externalId.slice(0, 8)}  w-3  `)).toBe(true)
    const json = JSON.parse((await run(coordinator, ['pane', 'status', '--json'])).stdout)
    expect(json.panes.map((p: { pane: string }) => p.pane)).toEqual([worker.externalId])
  }, 30_000)

  it('refuses an unknown pane with the command that lists the panes', async () => {
    const unknown = await run(coordinator, ['pane', 'status', 'not-a-pane'])
    expect(unknown.code).not.toBe(0)
    expect(unknown.stderr).toContain('unknown-pane')
    expect(unknown.stderr).toContain('List the panes you can reach with ostia pane list')
  }, 30_000)
})
