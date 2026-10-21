import { spawn } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  ExtensionResult,
  ExtensionSettingValues,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { agentPluginContent } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FAKE } from '../../test/fixtures/secrets/samples'
import type { PanelModel } from '../extensions/activity/view'
import { registerControlServer, stopControlServer } from '../main/control/controlServer'
import { type PaneIdentity, registerPane } from '../main/control/idRegistry'
import { ExtensionHost } from '../main/extensions/extensionHost'
import { registerExtensionMethods } from '../main/extensions/extensionMethods'
import { ExtensionStore } from '../main/extensions/extensionStore'
import { registerPaneListMethods } from '../main/panes/paneList'
import { createRedactor } from '../main/privacy/redaction'
import { scanSecrets } from '../main/privacy/secretScanner'
import {
  setAgentPlugins,
  shellIntegrationDir,
  shellIntegrationSpawnOptions,
} from '../main/terminal/shellIntegration'
import type { CommandResult } from '../shared/control/commands'

const repoRoot = process.cwd()
const cliPath = join(repoRoot, 'out', 'cli', 'index.js')
const builtExtension = join(repoRoot, 'out', 'extensions', 'activity')

const FAKE_AGENT = `#!/usr/bin/env node
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const agent = process.argv[1].endsWith('codex') ? 'codex' : 'claude'
const args = process.argv.slice(2)
const commands = {}
if (agent === 'claude') {
  const dir = args[args.indexOf('--plugin-dir') + 1]
  const hooks = JSON.parse(readFileSync(join(dir, 'hooks', 'hooks.json'), 'utf8')).hooks
  for (const [event, groups] of Object.entries(hooks)) {
    commands[event] = groups.flatMap((group) => group.hooks.map((hook) => hook.command))
  }
} else {
  for (const arg of args) {
    const event = (arg.match(/^hooks\\.([A-Za-z]+)=/) || [])[1]
    if (!event) continue
    commands[event] = [...arg.matchAll(/command=("(?:[^"\\\\]|\\\\.)*")/g)].map((m) => JSON.parse(m[1]))
  }
}
for (const [event, payload] of JSON.parse(readFileSync(process.env.FAKE_AGENT_EVENTS, 'utf8'))) {
  for (const command of commands[event] || []) {
    if (!command.includes(' agent-hook activity ')) continue
    const out = execFileSync('sh', ['-c', command], { input: JSON.stringify(payload), encoding: 'utf8' })
    console.log('hook ' + event + ' [' + out.trim() + ']')
  }
}
`

type HookPayload = [string, Record<string, unknown>]

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} timed out (${stdout} ${stderr})`))
    }, 30_000)
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString()
    })
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString()
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end('')
  })
}

const POLL = { timeout: 10_000, interval: 50 }

describe('the Activity extension records two fake agents and shows them in its panel (real CLI, real socket)', () => {
  let dir: string
  let bin: string
  let dataDir: string
  let socketPath: string
  let agentDir: string
  let host: ExtensionHost
  let serving: ExtensionHost
  let claudePane: PaneIdentity
  let codexPane: PaneIdentity
  let quietPane: PaneIdentity
  let scratchPane: PaneIdentity
  let storedSettings: Record<string, ExtensionSettingValues> = {}
  const focusPaneIn = vi.fn<(pane: PaneIdentity) => boolean>()
  const redactor = createRedactor(
    () => ({ redaction: { enabled: true } }),
    (text) => scanSecrets(text),
  )
  const journalFile = (workspaceId: string): string =>
    join(dataDir, 'activity', 'journal', `${workspaceId}.jsonl`)

  function newHost(): ExtensionHost {
    return new ExtensionHost({
      sandboxDomains: () => null,
      isSandboxed: () => false,
      roots: [{ dir: join(dir, 'builtin'), builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      dataDir,
      workDirForWorkspace: () => dir,
      broadcast: (channel, payload) => {
        if (channel !== 'extensions:settings-stored') return
        const { extId, stored } = payload as { extId: string; stored: ExtensionSettingValues }
        storedSettings = { ...storedSettings, [extId]: stored }
      },
      readExtensionSettings: () => storedSettings,
      redact: redactor.redact,
      focusPaneIn,
      openPanelIn: () => {},
      notify: () => {},
      requestTimeoutMs: 8000,
      readyTimeoutMs: 8000,
      log: () => {},
    })
  }

  function paneEnv(identity: PaneIdentity, events: HookPayload[]): NodeJS.ProcessEnv {
    const eventsFile = join(dir, `events-${identity.paneId}.json`)
    writeFileSync(eventsFile, JSON.stringify(events))
    return {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: dir,
      OSTIA_CLI: cliPath,
      OSTIA_NODE: process.execPath,
      OSTIA_SOCKET: socketPath,
      OSTIA_TOKEN: identity.token,
      OSTIA_AGENT_DIR: agentDir,
      FAKE_AGENT_EVENTS: eventsFile,
    }
  }

  function runAgent(
    agent: 'claude' | 'codex',
    identity: PaneIdentity,
    events: HookPayload[],
  ): Promise<RunResult> {
    const bashInit = join(shellIntegrationDir(), 'init.bash')
    return run(
      'bash',
      ['--norc', '-c', `source '${bashInit}'; ${agent}`],
      paneEnv(identity, events),
    )
  }

  async function panel(
    command: string,
    args: unknown = {},
    workspaceId = 'w1',
  ): Promise<ExtensionResult> {
    const source = await serving.panels.resolvePanel('activity', {
      workspaceId,
      locale: 'en',
    })
    if (!source.ok) throw new Error(source.error)
    const url = new URL(source.src)
    const res = await fetch(new URL('/api', url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ostia-panel': url.searchParams.get('t') ?? '',
      },
      body: JSON.stringify({ command, args, context: { workspaceId } }),
    })
    return (await res.json()) as ExtensionResult
  }

  async function snapshot(workspaceId = 'w1'): Promise<PanelModel> {
    const res = await panel('snapshot', {}, workspaceId)
    if (!res.ok) throw new Error(res.error)
    return res.data as PanelModel
  }

  const eventCount = (model: PanelModel): number =>
    (model.workspace?.agents ?? []).reduce((sum, agent) => sum + agent.current.events.length, 0)

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-activity-'))
    bin = join(dir, 'bin')
    dataDir = join(dir, 'extension-data')
    socketPath = join(dir, 'control.sock')
    cpSync(builtExtension, join(dir, 'builtin', 'activity'), { recursive: true })
    claudePane = registerPane({ windowId: 'w', workspaceId: 'w1', paneId: 'pActivityClaude' })
    codexPane = registerPane({ windowId: 'w', workspaceId: 'w1', paneId: 'pActivityCodex' })
    quietPane = registerPane({ windowId: 'w', workspaceId: 'w1', paneId: 'pActivityQuiet' })
    scratchPane = registerPane({ windowId: 'w', workspaceId: 'sc1', paneId: 'pActivityScratch' })
    host = newHost()
    serving = host
    registerExtensionMethods(() => serving)
    registerPaneListMethods({
      execCommand: async (_target, id) =>
        ({
          ok: true,
          result:
            id === 'workspace.list'
              ? [
                  {
                    workspaceId: 'w1',
                    name: 'shop',
                    kind: 'terminal',
                    workDir: dir,
                    state: 'idle',
                  },
                  {
                    workspaceId: 'sc1',
                    name: 'notes',
                    kind: 'scratch',
                    workDir: dir,
                    state: 'idle',
                  },
                ]
              : [
                  {
                    paneId: 'pActivityClaude',
                    workspaceId: 'w1',
                    kind: 'terminal',
                    title: 'claude',
                    agent: 'claude',
                    agentSessionId: 'sess-claude-1',
                    agentState: 'done',
                  },
                  {
                    paneId: 'pActivityCodex',
                    workspaceId: 'w1',
                    kind: 'terminal',
                    title: 'codex',
                    agent: 'codex',
                    agentSessionId: 'sess-codex-1',
                    agentState: 'working',
                  },
                  { paneId: 'pActivityQuiet', workspaceId: 'w1', kind: 'terminal', title: 'bash' },
                  {
                    paneId: 'pActivityScratch',
                    workspaceId: 'sc1',
                    kind: 'terminal',
                    title: 'claude',
                  },
                ],
        }) as CommandResult,
      getTerminalState: () => undefined,
      ptyPid: () => undefined,
      windowIds: () => ['w'],
      waking: () => false,
    })
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
        isSandboxed: () => false,
      },
      socketPath,
    )
    shellIntegrationSpawnOptions('/bin/bash', {})
    agentDir = setAgentPlugins(agentPluginContent(host.contributions.agentPlugins()))
    mkdirSync(bin, { recursive: true })
    for (const agent of ['claude', 'codex']) {
      writeFileSync(join(bin, agent), FAKE_AGENT)
      chmodSync(join(bin, agent), 0o755)
    }
  }, 120_000)

  afterAll(() => {
    serving.processes.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('shows each agent’s prompt line, tool events and stop in order, and the recap after the stop', async () => {
    const claude = await runAgent('claude', claudePane, [
      [
        'UserPromptSubmit',
        { session_id: 'c-1', prompt: `deploy with ${FAKE.githubClassic}\nand a second line` },
      ],
      [
        'PreToolUse',
        {
          session_id: 'c-1',
          cwd: '/w/shop',
          tool_name: 'Edit',
          tool_input: { file_path: '/w/shop/src/cart.ts', new_string: 'edited body' },
        },
      ],
      [
        'PreToolUse',
        { session_id: 'c-1', tool_name: 'Bash', tool_input: { command: 'pnpm test' } },
      ],
      [
        'Stop',
        {
          session_id: 'c-1',
          last_assistant_message: 'Fixed the cart total.\n\nAll tests pass.',
        },
      ],
    ])
    expect(claude.stderr).toBe('')
    expect(claude.stdout.split('\n').filter(Boolean)).toEqual([
      'hook UserPromptSubmit []',
      'hook PreToolUse []',
      'hook PreToolUse []',
      'hook Stop []',
    ])
    const codex = await runAgent('codex', codexPane, [
      ['UserPromptSubmit', { session_id: 'x-9', turn_id: 't-1', prompt: 'write the docs' }],
      ['PreToolUse', { session_id: 'x-9', tool_name: 'Bash', tool_input: { command: 'ls docs' } }],
    ])
    expect(codex.stderr).toBe('')
    expect(codex.stdout.split('\n').filter(Boolean)).toEqual([
      'hook UserPromptSubmit []',
      'hook PreToolUse []',
    ])

    const model = await vi.waitUntil(async () => {
      const current = await snapshot()
      return eventCount(current) === 6 ? current : undefined
    }, POLL)
    expect(model.showActivity).toBe(false)
    const [earlier, latest] = model.workspace?.agents ?? []
    expect(latest).toMatchObject({
      paneId: codexPane.externalId,
      label: { agent: 'codex', n: 1 },
      state: 'working',
    })
    expect('recap' in latest).toBe(false)
    expect(latest.current.events.map((e) => [e.kind, e.tool, e.text])).toEqual([
      ['prompt', undefined, 'write the docs'],
      ['tool', 'command', 'ls docs'],
    ])
    expect(earlier).toMatchObject({
      paneId: claudePane.externalId,
      label: { agent: 'claude', n: 1 },
      state: 'done',
      recap: 'Fixed the cart total.\nAll tests pass.',
    })
    expect(earlier.current.events.map((e) => [e.kind, e.tool, e.text])).toEqual([
      ['prompt', undefined, expect.stringMatching(/^deploy with (?!ghp_)\S+$/)],
      ['tool', 'edit', 'src/cart.ts'],
      ['tool', 'command', 'pnpm test'],
      ['stop', undefined, 'Fixed the cart total.\nAll tests pass.'],
    ])
    expect(JSON.stringify(model)).not.toContain('edited body')
    expect(JSON.stringify(model)).not.toContain('second line')
  }, 90_000)

  it('keeps the journal 0600 on disk without the secret from the prompt', () => {
    const file = journalFile('w1')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700)
    const text = readFileSync(file, 'utf8')
    expect(text.trim().split('\n')).toHaveLength(6)
    expect(text).toContain('deploy with ')
    expect(text).not.toContain(FAKE.githubClassic)
  })

  it('shows a scratch workspace’s agent from memory and leaves no journal for it', async () => {
    await runAgent('claude', scratchPane, [
      ['UserPromptSubmit', { session_id: 's-3', prompt: 'jot this down' }],
    ])
    const model = await vi.waitUntil(async () => {
      const current = await snapshot('sc1')
      return current.workspace ? current : undefined
    }, POLL)
    expect(model.workspace?.agents[0].current.prompt).toBe('jot this down')
    expect(JSON.stringify(await snapshot('w1'))).not.toContain('jot this down')
    expect(existsSync(journalFile('sc1'))).toBe(false)
    expect(readdirSync(dirname(journalFile('w1')))).toEqual(['w1.jsonl'])
  }, 60_000)

  it('focuses the pane of an agent whose hook reached it, and no other pane', async () => {
    focusPaneIn.mockReturnValue(true)
    expect(await panel('focus', { paneId: claudePane.externalId })).toEqual({ ok: true })
    expect(focusPaneIn.mock.calls.map(([pane]) => pane.paneId)).toEqual(['pActivityClaude'])
    const bashInit = join(shellIntegrationDir(), 'init.bash')
    const opened = await run(
      'bash',
      ['--norc', '-c', `source '${bashInit}'; ostia activity open`],
      paneEnv(quietPane, []),
    )
    expect(opened.code).toBe(0)
    expect(await panel('focus', { paneId: quietPane.externalId })).toMatchObject({
      ok: false,
      error: 'not-reached',
    })
    expect(focusPaneIn).toHaveBeenCalledTimes(1)
  })

  it('remembers the toggle and the journal across a restart, and forgets the scratch workspace', async () => {
    expect(await panel('setShowActivity', { value: true })).toMatchObject({ ok: true })
    expect((await snapshot()).showActivity).toBe(true)
    expect(storedSettings).toEqual({ activity: { showActivity: true } })

    host.processes.stopAll()
    await vi.waitUntil(
      async () => host.list().find((e) => e.id === 'activity')?.status !== 'running',
      POLL,
    )
    serving = newHost()

    const model = await snapshot()
    expect(model.showActivity).toBe(true)
    const claude = model.workspace?.agents.find((a) => a.paneId === claudePane.externalId)
    expect(claude?.recap).toBe('Fixed the cart total.\nAll tests pass.')
    expect(claude?.current.events.map((e) => e.kind)).toEqual(['prompt', 'tool', 'tool', 'stop'])
    expect(await panel('setShowActivity', { value: false })).toMatchObject({ ok: true })
    expect((await snapshot()).showActivity).toBe(false)
  }, 60_000)

  it('answers the panel’s snapshot right after a restart while the extension still loads its settings', async () => {
    serving.processes.stopAll()
    await vi.waitUntil(
      async () => serving.list().find((e) => e.id === 'activity')?.status !== 'running',
      POLL,
    )
    const restarted = newHost()
    const loaded = restarted.config.getSettings.bind(restarted.config)
    const slowSettings = (
      ...args: Parameters<typeof loaded>
    ): Promise<ReturnType<typeof loaded>> => {
      const values = loaded(...args)
      return new Promise((resolve) => setTimeout(() => resolve(values), 500))
    }
    vi.spyOn(restarted.config, 'getSettings').mockImplementation(
      slowSettings as unknown as typeof loaded,
    )
    serving = restarted

    expect(await panel('snapshot', {})).toMatchObject({ ok: true, data: { showActivity: false } })
  }, 60_000)

  it('lets an agent add a needs-you item, read it back, count it in the sidebar, and the human mark it done', async () => {
    const bashInit = join(shellIntegrationDir(), 'init.bash')
    const ostia = (identity: PaneIdentity, command: string): Promise<RunResult> =>
      run('bash', ['--norc', '-c', `source '${bashInit}'; ${command}`], paneEnv(identity, []))
    const openCount = (): string | undefined =>
      serving.slots.sidebarItems().find((i) => i.extId === 'activity' && i.workspaceId === 'w1')
        ?.badge

    const added = await ostia(
      claudePane,
      `ostia activity add "Put ${FAKE.githubClassic} into .env.local" --needs-you --link /w/shop/.env.example`,
    )
    expect(added.stderr).toBe('')
    expect(added.code).toBe(0)
    const id = added.stdout.trim()
    expect(id).toMatch(/^[a-z2-7]{10}$/)
    expect(readFileSync(journalFile('w1'), 'utf8')).not.toContain(FAKE.githubClassic)
    expect(await vi.waitUntil(async () => (openCount() === '1' ? '1' : undefined), POLL)).toBe('1')

    const listed = await ostia(codexPane, 'ostia activity list --open --json')
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ id, kind: 'note', needsYou: true, link: '/w/shop/.env.example' }),
    ])
    const notYours = await ostia(codexPane, `ostia activity done ${id}`)
    expect(notYours.code).toBe(1)
    expect(notYours.stderr).toContain('marks only its own items')

    expect((await snapshot()).workspace?.notes.find((n) => n.id === id)).toBeUndefined()
    const inboxItem = () =>
      serving.slots
        .inboxEntries()
        .find((e) => e.extId === 'activity' && e.workspaceId === 'w1')
        ?.items.find((item) => item.id === id)
    expect(await vi.waitUntil(async () => inboxItem(), POLL)).toMatchObject({
      text: expect.stringContaining('into .env.local'),
    })
    expect(serving.slots.inboxAction('activity', 'w2', id)).toBe(false)
    expect(serving.slots.inboxAction('activity', 'w1', id)).toBe(true)
    await vi.waitUntil(async () => openCount() === undefined, POLL)
    await vi.waitUntil(async () => (inboxItem() === undefined ? true : undefined), POLL)
    expect((await snapshot()).workspace?.notes.find((n) => n.id === id)).toMatchObject({
      needsYou: true,
      done: true,
    })

    const shown = await ostia(claudePane, `ostia activity show ${id} --json`)
    expect(JSON.parse(shown.stdout)).toMatchObject({ id, needsYou: true, done: true })
  }, 60_000)

  it('lets an agent remember a task, gives it back after a compaction and a resume but not at a start, and the human archive and restore it', async () => {
    const bashInit = join(shellIntegrationDir(), 'init.bash')
    const ostia = (identity: PaneIdentity, command: string): Promise<RunResult> =>
      run('bash', ['--norc', '-c', `source '${bashInit}'; ${command}`], paneEnv(identity, []))
    const sessionStart = async (source: string): Promise<string> => {
      const out = await runAgent('claude', claudePane, [
        ['SessionStart', { session_id: 'sess-claude-1', source }],
      ])
      return out.stdout
    }

    const added = await ostia(
      claudePane,
      `ostia activity remember "Bisect ${FAKE.githubClassic} fixtures"`,
    )
    expect(added.stderr).toBe('')
    expect(added.code).toBe(0)
    const id = /^remembered ([a-z2-7]{10})$/.exec(added.stdout.trim())?.[1] ?? ''
    expect(id).not.toBe('')
    const stored = readFileSync(join(dataDir, 'activity', 'remember', 'w1.json'), 'utf8')
    expect(stored).not.toContain(FAKE.githubClassic)
    expect(statSync(join(dataDir, 'activity', 'remember', 'w1.json')).mode & 0o777).toBe(0o600)

    const mine = await ostia(claudePane, 'ostia activity list --remembered')
    expect(mine.stdout).toContain(`${id}\t`)
    const other = await ostia(codexPane, 'ostia activity list --remembered')
    expect(other.stdout.trim()).toBe('no entries')

    expect(await sessionStart('compact')).toContain(`[${id}]`)
    expect(await sessionStart('resume')).toContain(`[${id}]`)
    expect(await sessionStart('startup')).not.toContain(id)

    expect(await panel('rememberState', { id, state: 'archived' })).toEqual({ ok: true })
    expect(await sessionStart('compact')).not.toContain(id)
    const view = (await snapshot()) as unknown as {
      remember: { counts: Record<string, number> }
    }
    expect(view.remember.counts).toMatchObject({ open: 0, archived: 1 })
    expect(await panel('rememberState', { id, state: 'open' })).toEqual({ ok: true })
    expect(await sessionStart('clear')).toContain(`[${id}]`)

    const notYours = await ostia(codexPane, `ostia activity done ${id}`)
    expect(notYours.code).toBe(1)
    expect(notYours.stderr).toContain('finishes only its own')
    const done = await ostia(claudePane, `ostia activity done ${id}`)
    expect(done.stdout.trim()).toBe(`${id} done`)
    expect(await sessionStart('resume')).not.toContain(id)
  }, 60_000)
})
