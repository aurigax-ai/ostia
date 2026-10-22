import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HookAgent } from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../shared/control/commands'
import { shortId } from '../shared/panes/paneStatus'
import type { ApprovalOutcome } from '../shared/permissions/approvals'

const dir = mkdtempSync(join(tmpdir(), 'ostia-cli-bus-'))
process.env.XDG_DATA_HOME = join(dir, 'data')

let answer: ApprovalOutcome = 'once'
const request = vi.fn(async () => answer)
vi.mock('../main/approvals/approvals', () => ({ approvals: () => ({ request }) }))

const { registerBusMethods } = await import('../main/agents/busMethods')
const { failPaneMail, flushBus, postBusMessage, resetBus, sentBy } = await import(
  '../main/agents/busStore'
)
const { registerPaneNameMethods } = await import('../main/panes/paneNameMethods')
const { registerControlServer, stopControlServer } = await import('../main/control/controlServer')
const { registerPane } = await import('../main/control/idRegistry')
const { busHookCommand } = await import('../main/terminal/agentHookCommands')
const { claudeHookSettings } = await import('../main/terminal/claudeIntegration')
const { codexHookCommands } = await import('../main/terminal/codexIntegration')

const cliPath = join(process.cwd(), 'out', 'cli', 'index.js')
const socketPath = join(dir, 'control.sock')
const contextFile = join(dir, 'session-context.md')
const CODEX_CONTEXT = 'This Codex session runs in a ostia terminal pane.\n'

const announce = vi.fn()
const outOfScope = new Set<string>()
registerBusMethods({
  hibernated: () => false,
  managerSendAllowed: () => true,
  agentBusy: () => false,
  announce,
  pending: async () => 'idle-no-wake',
  reach: {
    processPane: async () => [],
    visible: async () => () => true,
    inScope: async (_ctx, workspaceId) => !outOfScope.has(workspaceId),
    isChild: () => false,
    isSandboxed: () => false,
    isConfined: () => false,
  },
})

registerPaneNameMethods({
  visible: async () => () => true,
  isSandboxed: () => false,
  isConfined: () => false,
  processPane: async () => [],
  agentRunning: () => true,
})

const sender = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'cli-bus-sender' })
const agent = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'cli-bus-agent' })
const other = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'cli-bus-other' })
const remote = registerPane({ windowId: 'w1', workspaceId: 'ws2', paneId: 'cli-bus-remote' })

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
    OSTIA_CLI: cliPath,
    OSTIA_NODE: process.execPath,
    OSTIA_SOCKET: socketPath,
    OSTIA_TOKEN: pane.token,
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

function ostia(pane: Pane, ...args: string[]): Promise<RunResult> {
  return run(process.execPath, [cliPath, ...args], paneEnv(pane))
}

function hookCommands(kind: HookAgent, event: HookEvent): string[] {
  if (kind === 'codex') return codexHookCommands(contextFile)[event] ?? []
  const hooks = claudeHookSettings().hooks as Record<string, { hooks: { command: string }[] }[]>
  return hooks[event]?.[0]?.hooks.map((hook) => hook.command) ?? []
}

async function fireHooks(
  kind: HookAgent,
  event: HookEvent,
  pane: Pane,
  source?: string,
): Promise<RunResult[]> {
  const payload = JSON.stringify({
    session_id: 's-1',
    hook_event_name: event,
    prompt: 'go on',
    ...(source ? { source } : {}),
  })
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
      isSandboxed: () => false,
    },
    socketPath,
  )
})

afterAll(async () => {
  stopControlServer()
  await flushBus()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  answer = 'once'
  outOfScope.clear()
  announce.mockClear()
  request.mockClear()
  await resetBus()
  rmSync(join(dir, 'data', 'ostia', 'bus.json'), { force: true })
})

describe('bus delivery through the real CLI and the agents’ own hooks', () => {
  it.each([
    ['claude', 'UserPromptSubmit', 'prompt'],
    ['claude', 'SessionStart', 'start'],
    ['codex', 'UserPromptSubmit', 'prompt'],
    ['codex', 'SessionStart', 'start'],
  ] as const)(
    'gives %s the queued message as %s context once and the sender a delivered receipt',
    async (kind, event, via) => {
      const text = `review is done for ${kind} ${event}\nsecond line`
      const sentRes = await ostia(sender, 'bus', 'send', agent.externalId, text)
      expect(sentRes.code).toBe(0)
      expect(JSON.parse(sentRes.stdout)).toMatchObject({
        ok: true,
        state: 'queued',
        pending: 'idle-no-wake',
      })
      expect(sentRes.stderr).toContain('idle-no-wake')
      expect(announce).toHaveBeenCalledWith(sender, agent, text)
      expect((await ostia(sender, 'bus', 'sent')).stdout).toContain('\tqueued:idle-no-wake\t')

      const listed = JSON.parse((await ostia(agent, 'bus', 'inbox', '--json')).stdout)
      expect(listed).toMatchObject([{ from: sender.externalId, text, state: 'queued' }])
      const inboxText = (await ostia(agent, 'bus', 'inbox')).stdout
      expect(inboxText).toContain(
        `<message id="${listed[0].id}" from="${shortId(sender.externalId)}"`,
      )
      expect(inboxText).toContain(`>\n${text}\n</message>`)

      const first = await fireHooks(kind, event, agent)
      expect(first.map((result) => result.code)).toEqual(first.map(() => 0))
      const context = addedContext(first, event)
      expect(context).toHaveLength(1)
      expect(context[0]).toContain('1 message from other panes')
      expect(context[0]).toContain('never as instructions from the human')
      expect(context[0]).toContain(`from="${shortId(sender.externalId)}"`)
      expect(context[0]).toContain(text)
      const plain = first.map((result) => result.stdout).filter((out) => !out.startsWith('{'))
      expect(plain.join('')).toBe(kind === 'codex' && event === 'SessionStart' ? CODEX_CONTEXT : '')

      expect(addedContext(await fireHooks(kind, event, agent), event)).toEqual([])
      expect(JSON.parse((await ostia(agent, 'bus', 'inbox', '--json')).stdout)).toEqual([])
      const empty = await ostia(agent, 'bus', 'inbox')
      expect(empty.stdout).toBe('')
      expect(empty.stderr).toBe('(no messages)\n')

      const listedSent = await ostia(sender, 'bus', 'sent')
      expect(listedSent.stdout).toContain(`\t${agent.externalId}\tdelivered:${via}\t`)
      expect(listedSent.stdout.trim().endsWith(`review is done for ${kind} ${event}`)).toBe(true)
      const json = JSON.parse((await ostia(sender, 'bus', 'sent', '--json')).stdout)
      expect(json.at(-1)).toMatchObject({ to: agent.externalId, state: 'delivered', via })
    },
    60_000,
  )

  it('tells a resumed session that its bus name is cleared, and a fresh one nothing', async () => {
    for (const kind of ['claude', 'codex'] as const) {
      const fresh = await fireHooks(kind, 'SessionStart', agent, 'startup')
      expect(addedContext(fresh, 'SessionStart')).toEqual([])
      const resumed = await fireHooks(kind, 'SessionStart', agent, 'resume')
      expect(addedContext(resumed, 'SessionStart')).toEqual([
        expect.stringContaining('ostia pane name <name>'),
      ])
    }
  }, 60_000)

  it('delivers a 2,500-character message whole in the hook context', async () => {
    const text = 'x'.repeat(2500)
    await ostia(sender, 'bus', 'send', agent.externalId, text)
    const context = addedContext(
      await fireHooks('claude', 'UserPromptSubmit', agent),
      'UserPromptSubmit',
    )
    expect(context).toHaveLength(1)
    expect(context[0]).toContain(`>\n${text}\n</message>`)
    expect(JSON.parse((await ostia(agent, 'bus', 'inbox', '--json')).stdout)).toEqual([])
  }, 60_000)

  it.each(['claude', 'codex'] as const)(
    'keeps a 9,000-character message queued for %s’s hooks and hands it over whole by bus inbox --take',
    async (kind) => {
      const text = 'z'.repeat(9000)
      await ostia(sender, 'bus', 'send', agent.externalId, text)
      const context = addedContext(
        await fireHooks(kind, 'UserPromptSubmit', agent),
        'UserPromptSubmit',
      )
      expect(context).toHaveLength(1)
      expect(context[0]).toContain('ostia bus inbox --take')
      expect(context[0]).not.toContain('zzzz')
      expect((await ostia(sender, 'bus', 'sent')).stdout).toContain('\tqueued:')
      expect((await ostia(agent, 'bus', 'inbox')).stdout).toContain(`>\n${text}\n</message>`)
      const taken = JSON.parse((await ostia(agent, 'bus', 'inbox', '--take', '--json')).stdout)
      expect(taken.map((m: { text: string }) => m.text)).toEqual([text])
      expect((await ostia(sender, 'bus', 'sent')).stdout).toContain('\tdelivered:read\t')
      expect(
        addedContext(await fireHooks(kind, 'UserPromptSubmit', agent), 'UserPromptSubmit'),
      ).toEqual([])
    },
    60_000,
  )

  it('prints nothing and exits 0 when the inbox is empty', async () => {
    const results = await fireHooks('claude', 'UserPromptSubmit', agent)
    expect(results.map((result) => result.code)).toEqual(results.map(() => 0))
    expect(results.map((result) => result.stdout).join('')).toBe('')
  }, 30_000)

  it('never fails the hook when Ostia cannot be reached', async () => {
    const res = await run(
      'sh',
      ['-c', busHookCommand('UserPromptSubmit')],
      { ...paneEnv(agent), OSTIA_SOCKET: join(dir, 'missing.sock') },
      '{}',
    )
    expect(res).toEqual({ code: 0, stdout: '', stderr: '' })
  }, 30_000)

  it('adds no context for a report Ostia delivered on the human’s action', async () => {
    postBusMessage(sender.externalId, agent.externalId, '{"kind":"capture","report":"/tmp/r.md"}')
    expect(
      addedContext(await fireHooks('claude', 'UserPromptSubmit', agent), 'UserPromptSubmit'),
    ).toEqual([])
    expect(announce).not.toHaveBeenCalled()
    expect(JSON.parse((await ostia(agent, 'bus', 'inbox', '--json')).stdout)).toHaveLength(1)
  }, 30_000)

  it('answers a wait that runs out on stderr with exit 3', async () => {
    const res = await ostia(agent, 'bus', 'wait', '--timeout', '1')
    expect(res.code).toBe(3)
    expect(res.stdout).toBe('')
    expect(res.stderr).toBe('ostia bus wait: timed-out: no message arrived\n')
  }, 60_000)

  it('delivers at once, with no hint, when the receiver is blocked in bus wait', async () => {
    const waiting = ostia(agent, 'bus', 'wait', '--timeout', '20', '--json')
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const res = await ostia(sender, 'bus', 'send', agent.externalId, 'are you there')
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: true, state: 'leased', via: 'read' })
    expect(res.stderr).toBe('')
    expect(announce).not.toHaveBeenCalled()
    const woken = JSON.parse((await waiting).stdout)
    expect(woken.timedOut).toBe(false)
    expect(woken.messages.map((m: { text: string }) => m.text)).toEqual(['are you there'])
    expect((await ostia(sender, 'bus', 'sent')).stdout).toContain('\tdelivered:read\t')
  }, 60_000)

  it('takes the first 8 characters of the receiver’s id', async () => {
    const res = await ostia(sender, 'bus', 'send', agent.externalId.slice(0, 8), 'by prefix')
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: true, state: 'queued' })
    const listed = JSON.parse((await ostia(agent, 'bus', 'inbox', '--json')).stdout)
    expect(listed.map((m: { text: string }) => m.text)).toEqual(['by prefix'])
    const unknown = await ostia(sender, 'bus', 'send', 'abcdef01', 'nobody')
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('unknown-pane')
  }, 30_000)

  it('sends to a registered name in another workspace once the human allowed all-workspaces', async () => {
    outOfScope.add('ws2')
    const upper = await ostia(remote, 'pane', 'name', 'Remote-Boss')
    expect(upper.code).toBe(1)
    expect(upper.stderr).toContain('bad-name')
    const named = await ostia(remote, 'pane', 'name', 'remote-boss', '--desc', 'plans')
    expect(named.code).toBe(0)
    expect(named.stdout).toBe(`${remote.externalId.slice(0, 8)}\tremote-boss\tplans\n`)

    const taken = await ostia(sender, 'pane', 'name', 'remote-boss')
    expect(taken.code).toBe(1)
    expect(taken.stderr).toContain(`name-taken: remote-boss held by ${remote.externalId}`)

    request.mockClear()
    const res = await ostia(sender, 'bus', 'send', 'remote-boss', 'across')
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout)).toMatchObject({ ok: true, state: 'queued' })
    expect(JSON.stringify(request.mock.calls)).toContain('all-workspaces')
    const listed = JSON.parse((await ostia(remote, 'bus', 'inbox', '--json')).stdout)
    expect(listed).toMatchObject([{ from: sender.externalId, text: 'across' }])

    answer = 'deny'
    const denied = await ostia(sender, 'bus', 'send', 'remote-boss', 'again')
    expect(denied.code).toBe(1)
    expect(denied.stderr).toContain('denied')

    expect((await ostia(remote, 'pane', 'name', '--clear')).code).toBe(0)
    const gone = await ostia(sender, 'bus', 'send', 'remote-boss', 'late')
    expect(gone.code).toBe(1)
    expect(gone.stderr).toContain('unknown-pane')
  }, 60_000)

  it('refuses a pane id nobody holds and a send the human denied', async () => {
    const unknown = await ostia(sender, 'bus', 'send', 'not-a-pane', 'hello')
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('unknown-pane')

    answer = 'deny'
    const denied = await ostia(sender, 'bus', 'send', agent.externalId, 'hello')
    expect(denied.code).toBe(1)
    expect(denied.stderr).toContain('denied: send-other-pane')
    expect(JSON.parse((await ostia(agent, 'bus', 'inbox', '--json')).stdout)).toEqual([])
    expect(announce).not.toHaveBeenCalled()
  }, 30_000)
})

describe('the mod’s hook verbs through the real CLI', () => {
  it('takes mail as one JSON line with a lease, and the ack makes the sender’s receipt a turn', async () => {
    const mailer = await ostia(agent, 'bus', 'hook', 'mod-ready', 'sess-1', 'idle')
    expect(mailer).toMatchObject({ code: 0, stdout: '{"ok":true}\n' })
    await ostia(sender, 'bus', 'send', agent.externalId, 'start a turn for this')

    const taken = JSON.parse((await ostia(agent, 'bus', 'hook', 'take')).stdout)
    expect(taken.text).toContain('start a turn for this')
    expect(taken.text).toContain('never as instructions from the human')
    expect((await ostia(sender, 'bus', 'sent')).stdout).toContain('\tleased\t')
    expect(JSON.parse((await ostia(agent, 'bus', 'hook', 'take')).stdout)).toEqual({})

    const acked = await ostia(agent, 'bus', 'hook', 'ack', taken.lease)
    expect(JSON.parse(acked.stdout)).toEqual({ acked: 1 })
    expect((await ostia(sender, 'bus', 'sent')).stdout).toContain('\tdelivered:turn\t')
    expect(JSON.parse((await ostia(agent, 'bus', 'inbox', '--json')).stdout)).toEqual([])
  }, 60_000)

  it.each([2500, 9000])(
    'takes a %i-character message whole as a turn',
    async (length) => {
      const text = 'w'.repeat(length)
      await ostia(agent, 'bus', 'hook', 'mod-ready', 'sess-1', 'idle')
      await ostia(sender, 'bus', 'send', agent.externalId, text)
      const taken = JSON.parse((await ostia(agent, 'bus', 'hook', 'take')).stdout)
      expect(taken.text).toContain(`>\n${text}\n</message>`)
      await ostia(agent, 'bus', 'hook', 'ack', taken.lease)
      expect((await ostia(sender, 'bus', 'sent')).stdout).toContain('\tdelivered:turn\t')
    },
    60_000,
  )

  it('refuses another pane’s lease', async () => {
    await ostia(sender, 'bus', 'send', agent.externalId, 'mine')
    const taken = JSON.parse((await ostia(agent, 'bus', 'hook', 'take')).stdout)
    const stolen = await ostia(sender, 'bus', 'hook', 'ack', taken.lease)
    expect(JSON.parse(stolen.stdout)).toEqual({ acked: 0 })
    expect((await ostia(sender, 'bus', 'sent')).stdout).toContain('\tleased\t')
  }, 60_000)
})

describe('bus send --wait through the real CLI', () => {
  async function waitForSend(from: Pane): Promise<void> {
    await vi.waitUntil(() => sentBy(from.externalId).length === 1, {
      timeout: 10_000,
      interval: 25,
    })
  }

  it('prints the receiver’s reply and exits 0, taking only that reply', async () => {
    const waiting = ostia(sender, 'bus', 'send', '--wait', '30', agent.externalId, 'status?')
    await waitForSend(sender)
    await ostia(other, 'bus', 'send', sender.externalId, 'from a third pane')
    await ostia(agent, 'bus', 'send', sender.externalId, 'all green')
    const res = await waiting
    expect(res.code).toBe(0)
    expect(res.stdout).toContain(`from="${shortId(agent.externalId)}"`)
    expect(res.stdout).toContain('all green')
    expect(res.stdout).not.toContain('from a third pane')
    expect(res.stderr).toMatch(/^sent [0-9a-f-]{36}\n$/)
    const left = JSON.parse((await ostia(sender, 'bus', 'inbox', '--json')).stdout)
    expect(left.map((m: { text: string }) => m.text)).toEqual(['from a third pane'])
  }, 60_000)

  it('does not take a message the receiver sent before the question', async () => {
    await ostia(agent, 'bus', 'send', sender.externalId, 'an older note')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const res = await ostia(sender, 'bus', 'send', '--wait', '1', agent.externalId, 'status?')
    expect(res.code).toBe(3)
    expect(res.stdout).toBe('')
    const left = JSON.parse((await ostia(sender, 'bus', 'inbox', '--json')).stdout)
    expect(left.map((m: { text: string }) => m.text)).toEqual(['an older note'])
  }, 30_000)

  it('exits 3 and names the message state when no reply comes in time', async () => {
    const res = await ostia(sender, 'bus', 'send', '--wait', '1', agent.externalId, 'anyone?')
    expect(res.code).toBe(3)
    expect(res.stdout).toBe('')
    expect(res.stderr).toContain(
      `ostia bus send: timed-out: ${agent.externalId} sent no reply; the message is queued:idle-no-wake`,
    )
  }, 30_000)

  it('refuses a second --wait to the same pane while the first still waits', async () => {
    const first = ostia(sender, 'bus', 'send', '--wait', '30', agent.externalId, 'first?')
    await waitForSend(sender)
    const second = await ostia(sender, 'bus', 'send', '--wait', '5', agent.externalId, 'second?')
    expect(second.code).toBe(1)
    expect(second.stderr).toContain('busy:')
    expect(sentBy(sender.externalId)).toHaveLength(1)
    await ostia(agent, 'bus', 'send', sender.externalId, 'one answer')
    expect((await first).stdout).toContain('one answer')
  }, 60_000)

  it('exits 1 with the reason as soon as the receiver’s pane closes', async () => {
    const waiting = ostia(sender, 'bus', 'send', '--wait', '30', agent.externalId, 'too late')
    await waitForSend(sender)
    failPaneMail(agent.externalId)
    const res = await waiting
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('ostia bus send: failed:pane-closed')
    expect((await ostia(sender, 'bus', 'sent')).stdout).toContain('\tfailed:pane-closed\t')
  }, 60_000)

  it('refuses a --wait that is not a number of seconds', async () => {
    const res = await ostia(sender, 'bus', 'send', '--wait', 'soon', agent.externalId, 'x')
    expect(res.code).not.toBe(0)
    expect(res.stderr).toContain("--wait expects seconds, got 'soon'")
  }, 30_000)
})
