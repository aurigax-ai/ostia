import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { skillFrontmatter } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../src/shared/control/commands'

const dir = mkdtempSync(join(tmpdir(), 'ostia-agent-tokens-'))
process.env.XDG_DATA_HOME = join(dir, 'data')

vi.mock('../src/main/approvals/approvals', () => ({
  approvals: () => ({ request: async () => 'once' }),
}))

const { CORE_SKILL_FILES, MANAGER_SKILL_FILES } = await import('../src/main/agents/bundledSkills')
const { registerBusMethods } = await import('../src/main/agents/busMethods')
const { flushBus, resetBus } = await import('../src/main/agents/busStore')
const { grant } = await import('../src/main/approvals/capabilityStore')
const { registerControlMethod, registerControlServer, stopControlServer } = await import(
  '../src/main/control/controlServer'
)
const { registerDocsMethods } = await import('../src/main/control/docs')
const { registerPane } = await import('../src/main/control/idRegistry')
const { registerPaneListMethods } = await import('../src/main/panes/paneList')
const { writeCodexIntegration } = await import('../src/main/terminal/codexIntegration')
const { USAGE_TABLE, nounUsage, topUsage } = await import('../src/cli/common/usageTable')
const { BUILTIN_SPECS, skillsDescription } = await import(
  '../src/renderer/lib/assist/chatToolSpecs'
)
const { BUILTIN_TOOL_ACCESS } = await import('../src/shared/assist/chatTools')

const cliPath = join(process.cwd(), 'out', 'cli', 'index.js')
const socketPath = join(dir, 'control.sock')
const results: Record<string, { chars: number; exit?: number }> = {}

function record(surface: string, text: string, exit?: number): void {
  results[surface] = exit === undefined ? { chars: text.length } : { chars: text.length, exit }
}

const WORKSPACES = ['bench-ws-1', 'bench-ws-2', 'bench-ws-3']
const caller = registerPane({ windowId: 'w1', workspaceId: WORKSPACES[0], paneId: 'bench-caller' })
const agent = registerPane({ windowId: 'w1', workspaceId: WORKSPACES[0], paneId: 'bench-agent' })
const panes = Array.from({ length: 12 }, (_, i) => {
  const workspaceId = WORKSPACES[i % WORKSPACES.length]
  registerPane({ windowId: 'w1', workspaceId, paneId: `bench-pane-${i}` })
  const isAgent = i % 2 === 0
  return {
    paneId: `bench-pane-${i}`,
    workspaceId,
    kind: 'terminal',
    title: isAgent ? `claude · w-${100 + i}` : `zsh · task ${i}`,
    cwd: `/home/u/projects/app-${i}`,
    ...(isAgent
      ? {
          agent: 'claude',
          agentSessionId: `0000000${i}-0000-4000-8000-00000000000${i % 10}`,
          agentState: i % 4 === 0 ? 'working' : 'waiting',
          agentMessage: i % 4 === 0 ? 'Running the unit tests' : 'Claude needs your permission',
        }
      : {}),
    ...(i < 6 ? { splitTabId: 'st-1', splitTabName: 'lead · workers' } : {}),
    ...(i === 11 ? { hibernated: true } : {}),
  }
})

const SCREEN = Array.from(
  { length: 200 },
  (_, i) => `line ${i}: building module ${i % 17} of the app, step ${i} of 200`,
).join('\n')

const PROCESSES = Array.from({ length: 5 }, (_, i) => ({
  id: `p-${i}`,
  name: `task-${i}`,
  cmd: `pnpm run task-${i} --watch`,
  cwd: `/home/u/projects/app-${i}`,
  status: i === 4 ? ('exited' as const) : ('running' as const),
  ...(i === 4 ? { exitCode: 0 } : {}),
  paneId: `00000000-0000-4000-8000-00000000010${i}`,
  startedAt: '2026-10-19T10:00:00.000Z',
}))

const SKILLS = Array.from({ length: 40 }, (_, i) => ({
  name: `team-skill-${i}`,
  description: `Use when the task touches area ${i} of the product: the steps, the checks to run before calling it done, and the files that hold the settings for it.`,
  path: `/home/u/.claude/skills/team-skill-${i}/SKILL.md`,
}))

const MESSAGE = 'Review done for #101: 3 files changed, the unit tests pass. Next: rebase on main.'

interface RunResult {
  code: number | null
  out: string
}

function ostia(pane: { token: string }, ...args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: dir,
        OSTIA_SOCKET: socketPath,
        OSTIA_TOKEN: pane.token,
      },
    })
    let out = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`ostia ${args.join(' ')} timed out`))
    }, 30_000)
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
    child.stdin.end()
  })
}

async function measure(surface: string, ...args: string[]): Promise<RunResult> {
  const run = await ostia(caller, ...args)
  record(surface, run.out, run.code ?? -1)
  return run
}

beforeAll(async () => {
  await resetBus()
  registerControlServer(
    {
      execCommand: async () => ({ ok: true }) as CommandResult,
      listCommandsFor: () => [],
      getTerminalState: () => undefined,
      isSandboxed: () => false,
    },
    socketPath,
  )
  registerBusMethods({
    managerSendAllowed: () => true,
    agentBusy: () => false,
    announce: () => {},
    pending: async () => 'idle-no-wake',
    reach: {
      processPane: async () => [],
      visible: async () => () => true,
      inScope: async () => true,
      isChild: () => false,
      isSandboxed: () => false,
      isConfined: () => false,
    },
  })
  registerPaneListMethods({
    execCommand: async (_target, id) =>
      ({ ok: true, result: id === 'pane.list' ? panes : [] }) as CommandResult,
    getTerminalState: (paneId) => ({
      paneId,
      generation: 1,
      cwd: panes.find((p) => p.paneId === paneId)?.cwd,
      running: true,
      blockCount: 12,
      lastExitCode: 0,
    }),
    ptyPid: () => 40_000,
    windowIds: () => ['w1'],
    waking: () => false,
    processOf: (paneId) =>
      paneId === 'bench-pane-1' ? { id: 'p-1', status: 'running', start: 'started' } : undefined,
  })
  registerDocsMethods({ extensions: () => [] })
  registerControlMethod('pane.read', {
    scripts: true,
    handler: () => ({ paneId: agent.externalId, text: SCREEN, running: true, lastExitCode: 0 }),
  })
  registerControlMethod('pane.input', {
    scripts: true,
    handler: () => ({
      ok: true,
      paneId: agent.externalId,
      bytes: 12,
      pasted: false,
      responded: true,
      turnStarted: true,
      running: true,
    }),
  })
  registerControlMethod('process.list', { scripts: true, handler: () => PROCESSES })
  for (const cap of [
    'all-workspaces',
    'read-board',
    'read-other-pane',
    'send-other-pane',
  ] as const) {
    grant(caller.externalId, cap)
  }
})

afterAll(async () => {
  stopControlServer()
  await flushBus()
  const out = process.env.AGENT_TOKENS_OUT
  if (out) writeFileSync(out, JSON.stringify(results))
  rmSync(dir, { recursive: true, force: true })
})

describe('static surfaces', () => {
  it('measures the bundled skills, their descriptions and the help texts', () => {
    for (const file of CORE_SKILL_FILES) record(`skill.ostia/${file.path}`, file.text)
    for (const file of MANAGER_SKILL_FILES) record(`skill.ostia-manager/${file.path}`, file.text)
    const descriptions = [CORE_SKILL_FILES[0], MANAGER_SKILL_FILES[0]].map(
      (file) => skillFrontmatter(file.text)?.description ?? '',
    )
    const extensions = join(process.cwd(), 'src', 'extensions')
    for (const ext of readdirSync(extensions)) {
      const skills = join(extensions, ext, 'skills')
      if (!existsSync(skills)) continue
      for (const skill of readdirSync(skills, { withFileTypes: true }).filter((d) =>
        d.isDirectory(),
      )) {
        const text = readFileSync(join(skills, skill.name, 'SKILL.md'), 'utf8')
        record(`skill.ext.${ext}/${skill.name}`, text)
        descriptions.push(skillFrontmatter(text)?.description ?? '')
      }
    }
    record('skill.listing', descriptions.join('\n'))
    record('skill.description.ostia', descriptions[0])
    record('help.top', topUsage())
    const agentNouns = USAGE_TABLE.filter((noun) => noun.audience === 'agent')
    record('help.nouns', agentNouns.map(nounUsage).join('\n'))
    expect(descriptions.every(Boolean)).toBe(true)
  })

  it('measures the Codex session context', () => {
    const codex = join(dir, 'codex')
    const { contextFile } = writeCodexIntegration(codex)
    record('hook.codex.session', readFileSync(contextFile, 'utf8'))
  })
})

describe('pi tool specs', () => {
  it('measures every tool declaration the Agent sends with each request', () => {
    const declarations = Object.keys(BUILTIN_TOOL_ACCESS).map((name) => {
      const spec = BUILTIN_SPECS[name as keyof typeof BUILTIN_SPECS]
      const description = name === 'load_skill' ? skillsDescription(SKILLS) : spec.description
      const json = JSON.stringify({
        type: 'function',
        function: { name, description, parameters: spec.inputSchema, strict: false },
      })
      record(`pi.tool.${name}`, json)
      return json
    })
    record('pi.tools', `[${declarations.join(',')}]`)
    expect(declarations).toHaveLength(Object.keys(BUILTIN_SPECS).length)
  })
})

describe('CLI answers through the real CLI', () => {
  it('measures the bus hook block for one waiting message and the inbox after it', async () => {
    await ostia(caller, 'bus', 'send', agent.externalId, MESSAGE)
    const hook = await ostia(agent, 'bus', 'hook', 'UserPromptSubmit')
    record('hook.bus.prompt', hook.out, hook.code ?? -1)
    expect(hook.out).toContain('additionalContext')
    const after = await ostia(agent, 'bus', 'inbox')
    record('cli.bus.inbox.after-hook', after.out, after.code ?? -1)
  })

  it('measures bus send, and an inbox and a wait of five messages', async () => {
    await measure('cli.bus.send', 'bus', 'send', agent.externalId, MESSAGE)
    for (let i = 0; i < 4; i += 1) await ostia(caller, 'bus', 'send', agent.externalId, MESSAGE)
    const inbox = await ostia(agent, 'bus', 'inbox')
    record('cli.bus.inbox', inbox.out, inbox.code ?? -1)
    expect(inbox.code).toBe(0)
    const wait = await ostia(agent, 'bus', 'wait', '--timeout', '5')
    record('cli.bus.wait', wait.out, wait.code ?? -1)
  })

  it('measures the listing and reading verbs', async () => {
    expect((await measure('cli.pane.list', 'pane', 'list')).code).toBe(0)
    expect((await measure('cli.pane.list.here', 'pane', 'list', '--here')).code).toBe(0)
    expect(
      (
        await measure(
          'cli.pane.list.live',
          'pane',
          'list',
          '--kind',
          'terminal',
          '--state',
          'working',
        )
      ).code,
    ).toBe(0)
    expect((await measure('cli.pane.read', 'pane', 'read', agent.externalId)).code).toBe(0)
    const send = await measure(
      'cli.pane.send',
      'pane',
      'send',
      agent.externalId,
      'run the tests',
      '--enter',
    )
    expect(send.code).toBe(0)
    expect((await measure('cli.process.list', 'process', 'list')).code).toBe(0)
    expect((await measure('cli.docs', 'docs')).code).toBe(0)
  })

  it('measures the answers to the mistakes agents make', async () => {
    await measure('usage.dotted', 'pane.list')
    await measure('usage.verb-help', 'bus', 'send', '--help')
    await measure('usage.unknown-verb', 'bus', 'read')
    await measure('usage.unknown-flag', 'pane', 'send', agent.externalId, 'x', '--bogus')
  })
})
