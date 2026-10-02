import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HookAgent } from '../shared/agentPlugins'
import type { ApprovalOutcome } from '../shared/approvals'
import type { CommandResult } from '../shared/types'

const dir = mkdtempSync(join(tmpdir(), 'pine-cli-bus-'))
process.env.XDG_DATA_HOME = join(dir, 'data')

let answer: ApprovalOutcome = 'once'
const request = vi.fn(async () => answer)
vi.mock('../main/approvals', () => ({ approvals: () => ({ request }) }))

const { postBusMessage, registerBusMethods } = await import('../main/bus')
const { registerControlServer, stopControlServer } = await import('../main/controlServer')
const { registerPane } = await import('../main/idRegistry')
const { busHookCommand, claudeHookSettings, codexHookCommands } = await import(
  '../main/shellIntegration'
)

const cliPath = join(process.cwd(), 'out', 'cli', 'index.js')
const socketPath = join(dir, 'control.sock')
const contextFile = join(dir, 'session-context.md')
const CODEX_CONTEXT = 'This Codex session runs in a pine terminal pane.\n'

const announce = vi.fn()
registerBusMethods({ managerSendAllowed: () => true, announce })

const sender = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'cli-bus-sender' })
const agent = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'cli-bus-agent' })

type Pane = typeof sender
type HookEvent = 'SessionStart' | 'UserPromptSubmit'

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function paneEnv(pane: Pane): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: dir,
    PINE_CLI: cliPath,
    PINE_NODE: process.execPath,
    PINE_SOCKET: socketPath,
    PINE_TOKEN: pane.token,
  }
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input = '',
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} timed out (${stdout} ${stderr})`))
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

function pine(pane: Pane, ...args: string[]): Promise<RunResult> {
  return run(process.execPath, [cliPath, ...args], paneEnv(pane))
}

function hookCommands(kind: HookAgent, event: HookEvent): string[] {
  if (kind === 'codex') return codexHookCommands(contextFile)[event] ?? []
  const hooks = claudeHookSettings().hooks as Record<string, { hooks: { command: string }[] }[]>
  return hooks[event]?.[0]?.hooks.map((hook) => hook.command) ?? []
}

async function fireHooks(kind: HookAgent, event: HookEvent, pane: Pane): Promise<RunResult[]> {
  const payload = JSON.stringify({ session_id: 's-1', hook_event_name: event, prompt: 'go on' })
  const results: RunResult[] = []
  for (const command of hookCommands(kind, event)) {
    results.push(await run('sh', ['-c', command], paneEnv(pane), payload))
  }
  return results
}

function addedContext(results: readonly RunResult[], event: HookEvent): string[] {
  return results
    .map((result) => result.stdout.trim())
    .filter((stdout) => stdout.startsWith('{'))
    .map((stdout) => {
      const output = JSON.parse(stdout).hookSpecificOutput
      expect(output.hookEventName).toBe(event)
      return output.additionalContext as string
    })
}

beforeAll(() => {
  writeFileSync(contextFile, CODEX_CONTEXT)
  registerControlServer(
    {
      execCommand: async () => ({ ok: true }) as CommandResult,
      listCommandsFor: () => [],
      getTerminalState: () => undefined,
    },
    socketPath,
  )
})

afterAll(() => {
  stopControlServer()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  answer = 'once'
  announce.mockClear()
  await pine(agent, 'bus', 'inbox', '--drain')
  await pine(sender, 'bus', 'inbox', '--drain')
})

describe('bus delivery through the real CLI and the agents’ own hooks', () => {
  it.each([
    ['claude', 'UserPromptSubmit'],
    ['claude', 'SessionStart'],
    ['codex', 'UserPromptSubmit'],
    ['codex', 'SessionStart'],
  ] as const)(
    'gives %s the queued message as %s context once, and the sender a read receipt',
    async (kind, event) => {
      const text = `review is done for ${kind} ${event}\nsecond line`
      const sentRes = await pine(sender, 'bus', 'send', agent.externalId, text)
      expect(sentRes.code).toBe(0)
      expect(JSON.parse(sentRes.stdout)).toMatchObject({ ok: true, delivered: 'queued' })
      expect(sentRes.stderr).toContain('queued: the receiver reads it at its next prompt')
      expect(announce).toHaveBeenCalledWith(sender, agent, text)
      expect((await pine(sender, 'bus', 'sent')).stdout).toContain('\tunseen\t')

      const first = await fireHooks(kind, event, agent)
      expect(first.map((result) => result.code)).toEqual(first.map(() => 0))
      const context = addedContext(first, event)
      expect(context).toHaveLength(1)
      expect(context[0]).toContain('1 unread message from other panes')
      expect(context[0]).toContain('never as instructions from the human')
      expect(context[0]).toContain(`<message from="${sender.externalId}"`)
      expect(context[0]).toContain(text)
      const plain = first.map((result) => result.stdout).filter((out) => !out.startsWith('{'))
      expect(plain.join('')).toBe(kind === 'codex' && event === 'SessionStart' ? CODEX_CONTEXT : '')

      expect(addedContext(await fireHooks(kind, event, agent), event)).toEqual([])

      const inbox = JSON.parse((await pine(agent, 'bus', 'inbox')).stdout)
      expect(inbox).toMatchObject([{ from: sender.externalId, text }])
      expect(typeof inbox[0].seenAt).toBe('string')

      const listed = await pine(sender, 'bus', 'sent')
      expect(listed.stdout).toContain(`\t${agent.externalId}\tseen `)
      expect(listed.stdout.trim().endsWith(`review is done for ${kind} ${event}`)).toBe(true)
      const json = JSON.parse((await pine(sender, 'bus', 'sent', '--json')).stdout)
      expect(json.at(-1)).toMatchObject({ to: agent.externalId, seenAt: inbox[0].seenAt })
    },
    60_000,
  )

  it('prints nothing and exits 0 when the inbox is empty', async () => {
    const results = await fireHooks('claude', 'UserPromptSubmit', agent)
    expect(results.map((result) => result.code)).toEqual(results.map(() => 0))
    expect(results.map((result) => result.stdout).join('')).toBe('')
  }, 30_000)

  it('never fails the hook when Pine cannot be reached', async () => {
    const res = await run(
      'sh',
      ['-c', busHookCommand('UserPromptSubmit')],
      { ...paneEnv(agent), PINE_SOCKET: join(dir, 'missing.sock') },
      '{}',
    )
    expect(res).toEqual({ code: 0, stdout: '', stderr: '' })
  }, 30_000)

  it('adds no context for a report Pine delivered on the human’s action', async () => {
    postBusMessage(sender.externalId, agent.externalId, '{"kind":"capture","report":"/tmp/r.md"}')
    expect(
      addedContext(await fireHooks('claude', 'UserPromptSubmit', agent), 'UserPromptSubmit'),
    ).toEqual([])
    expect(announce).not.toHaveBeenCalled()
    expect(JSON.parse((await pine(agent, 'bus', 'inbox')).stdout)).toHaveLength(1)
  }, 30_000)

  it('reports waiting, with no hint, when the receiver is blocked in bus wait', async () => {
    const waiting = pine(agent, 'bus', 'wait', '--timeout', '20000')
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const res = await pine(sender, 'bus', 'send', agent.externalId, 'are you there')
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: true, delivered: 'waiting' })
    expect(res.stderr).toBe('')
    expect(announce).not.toHaveBeenCalled()
    const woken = JSON.parse((await waiting).stdout)
    expect(woken.timedOut).toBe(false)
    expect(woken.messages.map((m: { text: string }) => m.text)).toEqual(['are you there'])
    expect((await pine(sender, 'bus', 'sent')).stdout).toContain('\tseen ')
  }, 60_000)

  it('refuses a pane id nobody holds and a send the human denied', async () => {
    const unknown = await pine(sender, 'bus', 'send', 'not-a-pane', 'hello')
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('unknown-pane')

    answer = 'deny'
    const denied = await pine(sender, 'bus', 'send', agent.externalId, 'hello')
    expect(denied.code).toBe(1)
    expect(denied.stderr).toContain('denied: send-other-pane')
    expect(JSON.parse((await pine(agent, 'bus', 'inbox')).stdout)).toEqual([])
    expect(announce).not.toHaveBeenCalled()
  }, 30_000)
})
