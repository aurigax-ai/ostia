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
    processPane: async () => undefined,
    inScope: async () => true,
    isChild: () => false,
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
    now: Date.now,
  })
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
    expect(second.stdout).toMatch(/^w-3 {2}done \d+s {2}exit 0 {2}feat\/inbox \+2 ↑1 {2}mail 0/)
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

  it('refuses an unknown pane and a call without a pane', async () => {
    const unknown = await run(coordinator, ['pane', 'status', 'not-a-pane'])
    expect(unknown.code).not.toBe(0)
    expect(unknown.stderr).toContain('unknown-pane')
    const none = await run(coordinator, ['pane', 'status'])
    expect(none.code).toBe(1)
    expect(none.stderr).toContain('usage: ostia pane')
  }, 30_000)
})
