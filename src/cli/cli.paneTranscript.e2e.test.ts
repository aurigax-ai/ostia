import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PaneEntry } from '../main/panes/paneList'

const dir = mkdtempSync(join(tmpdir(), 'ostia-cli-transcript-'))
process.env.XDG_DATA_HOME = join(dir, 'data')

const request = vi.fn(async () => 'once' as const)
vi.mock('../main/approvals/approvals', () => ({ approvals: () => ({ request }) }))

const { registerControlServer, stopControlServer } = await import('../main/control/controlServer')
const { registerPane } = await import('../main/control/idRegistry')
const { readTail, transcriptPath } = await import('../main/agents/transcriptFiles')
const { registerPaneTranscriptMethods } = await import('../main/panes/paneTranscript')

const cliPath = join(process.cwd(), 'out', 'cli', 'index.js')
const socketPath = join(dir, 'control.sock')
const home = join(dir, 'home')

const coordinator = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'cli-tr-boss' })
const worker = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'cli-tr-worker' })
const idle = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'cli-tr-idle' })

const SECRET = 'sk-live-abc123'

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function ostia(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: dir,
        OSTIA_SOCKET: socketPath,
        OSTIA_TOKEN: coordinator.token,
      },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('ostia timed out'))
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
    child.stdin.end('')
  })
}

beforeAll(() => {
  const projects = join(home, '.claude', 'projects', '-w')
  mkdirSync(projects, { recursive: true })
  const entries = [
    { type: 'user', message: { content: 'write the migration' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }] } },
    { type: 'user', message: { content: `use the key ${SECRET} to deploy` } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'pnpm db:migrate' } },
          { type: 'text', text: 'Migration applied.\nAll 14 steps ran.' },
        ],
      },
    },
  ]
  writeFileSync(
    join(projects, 'sess-9.jsonl'),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  )
  registerPaneTranscriptMethods({
    processPane: async () => [],
    visible: async () => () => true,
    inScope: async () => true,
    isChild: () => false,
    isSandboxed: () => false,
    isConfined: () => false,
    panes: async () =>
      [
        {
          paneId: worker.externalId,
          workspaceId: 'ws1',
          kind: 'terminal',
          title: 'w-1',
          running: false,
          blockCount: 0,
          agent: 'claude',
          agentSessionId: 'sess-9',
        },
        {
          paneId: idle.externalId,
          workspaceId: 'ws1',
          kind: 'terminal',
          title: 'shell',
          running: false,
          blockCount: 0,
        },
      ] as PaneEntry[],
    lines: async (resume, bytes) => {
      const path = transcriptPath(resume, home)
      return path ? readTail(path, bytes) : null
    },
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

afterAll(() => {
  stopControlServer()
  rmSync(dir, { recursive: true, force: true })
})

describe('ostia pane transcript through the real CLI', () => {
  it('prints the last turn as the agent wrote it, secret and all', async () => {
    const res = await ostia(['pane', 'transcript', worker.externalId])
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe(
      `> use the key ${SECRET} to deploy\n· Bash: pnpm db:migrate\nMigration applied.\nAll 14 steps ran.`,
    )
  }, 30_000)

  it('prints two turns with --turns and every turn with --full, and JSON on request', async () => {
    const two = await ostia(['pane', 'transcript', worker.externalId, '--turns', '2'])
    expect(two.stdout).toContain('> write the migration\nOn it.\n\n> use the key')
    const full = await ostia(['pane', 'transcript', worker.externalId, '--full', '--json'])
    expect(JSON.parse(full.stdout)).toMatchObject({ agent: 'claude', turns: 2 })
  }, 30_000)

  it('says no-transcript for a pane without an agent session, and refuses a bad flag mix', async () => {
    const none = await ostia(['pane', 'transcript', idle.externalId])
    expect(none.code).not.toBe(0)
    expect(none.stderr).toContain('no-transcript')
    const mixed = await ostia(['pane', 'transcript', worker.externalId, '--full', '--turns', '2'])
    expect(mixed.code).toBe(1)
    expect(mixed.stderr).toContain('usage: ostia pane')
  }, 30_000)
})
