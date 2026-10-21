import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ExtensionCaller } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node'
import type { QuestionState } from '../../shared/agents/questions'
import type { CommandResult } from '../../shared/control/commands'
import { AGENT_TASKS_PER_MINUTE, type HeldResume } from '../agents/extensionAgents'

const published: { windowId: string; state: QuestionState }[] = []
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  webContents: {
    fromId: (id: number) => ({
      isDestroyed: () => false,
      send: (_channel: string, state: QuestionState) =>
        published.push({ windowId: String(id), state }),
    }),
  },
}))

const dataHome = mkdtempSync(join(tmpdir(), 'ostia-graph-api-'))
process.env.XDG_DATA_HOME = dataHome

const { registerBusMethods } = await import('../agents/busMethods')
const { questions, registerExtensionQuestions, registerQuestions } = await import(
  '../approvals/questions'
)
const { registerControlServer, stopControlServer } = await import('../control/controlServer')
const { markManager, registerPane } = await import('../control/idRegistry')
const { PaneWaking } = await import('../panes/paneWaking')
const { registerExtensionWake } = await import('../panes/extensionWake')
const { ExtensionHost } = await import('./extensionHost')
const { registerExtensionMethods } = await import('./extensionMethods')
const { ExtensionStore } = await import('./extensionStore')

const fixtures = resolve(__dirname, '../../../test/fixtures/extensions-graphs')
const caller: ExtensionCaller = { kind: 'user', workspaceId: 'w1', capabilities: [] }

describe('the extension API a graph host needs', () => {
  let dir: string
  let socketPath: string
  let host: InstanceType<typeof ExtensionHost>
  let clock = 0
  const openTerminalIn = vi.fn()
  const resumeOf = vi.fn<(pane: unknown) => Promise<HeldResume | null>>()
  const hibernated = new Set<string>()
  const typed: string[] = []
  const waking = new PaneWaking()
  let wakeRejects = false
  const panes = registerPane.bind(null)
  const target = panes({ windowId: '7', workspaceId: 'w1', paneId: 'pane-target' })
  const sleeper = panes({ windowId: '7', workspaceId: 'w1', paneId: 'pane-sleeper' })
  const twin = panes({ windowId: '7', workspaceId: 'w1', paneId: 'pane-twin' })
  const held = panes({ windowId: '7', workspaceId: 'w1', paneId: 'pane-held' })
  const started = panes({ windowId: '7', workspaceId: 'w1', paneId: 'pane-started' })
  const manager = panes({ windowId: '7', workspaceId: 'w1', paneId: 'pane-manager' })
  markManager(manager.paneId)

  const call = async (extId: string, method: string, params?: unknown) => {
    const res = await host.invoke(extId, 'call', { method, params }, caller)
    if (!res.ok) return { rpcError: res.message }
    return res.data as Record<string, unknown>
  }

  const paneConn = async (identity: { token: string }) => {
    const socket = createConnection(socketPath)
    await new Promise((r) => socket.once('connect', r))
    const conn = createMessageConnection(
      new StreamMessageReader(socket),
      new StreamMessageWriter(socket),
    )
    conn.listen()
    await conn.sendRequest('hello', { token: identity.token })
    return { conn, close: () => socket.destroy() }
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-graph-api-host-'))
    socketPath = join(dir, 'control.sock')
    host = new ExtensionHost({
      sandboxDomains: () => null,
      isSandboxed: () => false,
      roots: [{ dir: fixtures, builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: () => dir,
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      openTerminalIn,
      resumeOf,
      agentArgv: (name) => ({ claude: ['claude'] })[name] ?? null,
      agentNames: () => ['claude'],
      agentTaskClock: () => clock,
      readyTimeoutMs: 8000,
      interactiveTimeoutMs: 8000,
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerBusMethods({
      hibernated: () => false,
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
    registerQuestions({ opened: () => {}, settled: () => {} })
    registerExtensionQuestions({
      windowOfWorkspace: (id) => (id === 'w1' ? '7' : undefined),
      extensionName: (id) => (id === 'runner' ? 'Runner' : id),
    })
    registerExtensionWake({
      openedBy: (caller, paneId) => host.openedBy(caller, paneId),
      hibernated: async (pane) => hibernated.has(pane.paneId),
      wake: async (pane) => {
        if (wakeRejects) throw new Error('window gone')
        if (pane.paneId === twin.paneId || pane.paneId === held.paneId) {
          return { woke: false, conflict: 'other tab' }
        }
        hibernated.delete(pane.paneId)
        typed.push(`${pane.paneId}: 'claude' --resume s1`)
        return { woke: true }
      },
      panes: async () => [],
      waking,
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
    for (const pane of [target, sleeper, held, manager]) {
      openTerminalIn.mockResolvedValueOnce(pane.externalId)
      await call('runner', 'ext.openTerminal', { command: ['true'], workspaceId: 'w1' })
    }
    openTerminalIn.mockReset()
  })

  afterAll(() => {
    host.processes.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    clock += 120_000
    openTerminalIn.mockReset()
    resumeOf.mockReset()
    typed.length = 0
  })

  it('GRF-C114 ext.busSend hands a message to a waiting pane at once, from the extension', async () => {
    const { conn, close } = await paneConn(target)
    const waiting = conn.sendRequest<{ messages: { text: string; from: string }[] }>('bus.wait', {
      timeoutMs: 10_000,
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(
      await call('runner', 'ext.busSend', { to: target.externalId, text: 'checks passed' }),
    ).toMatchObject({
      ok: true,
      state: 'delivered',
    })
    const got = await waiting
    expect(got.messages.map((m) => [m.text, m.from])).toEqual([['checks passed', 'runner']])
    close()
    expect(
      await call('runner', 'ext.busSend', { to: target.externalId, text: 'later' }),
    ).toMatchObject({
      ok: true,
      state: 'queued',
    })
  })

  it('GRF-C115 ext.busSend refuses without all-workspaces, to the manager, an unknown pane, long text and a pane caller', async () => {
    expect(
      (await call('limited', 'ext.busSend', { to: target.externalId, text: 'x' })).rpcError,
    ).toContain('needs-elevation: all-workspaces')
    expect(
      await call('runner', 'ext.busSend', { to: manager.externalId, text: 'x' }),
    ).toMatchObject({ error: 'unknown-pane' })
    expect(await call('runner', 'ext.busSend', { to: 'nope', text: 'x' })).toMatchObject({
      error: 'unknown-pane',
    })
    expect(
      await call('runner', 'ext.busSend', { to: target.externalId, text: 'x'.repeat(16_001) }),
    ).toMatchObject({
      error: 'invalid-params',
    })
    const { conn, close } = await paneConn(target)
    await expect(
      conn.sendRequest('ext.busSend', { to: started.externalId, text: 'x' }),
    ).rejects.toThrow()
    close()
  })

  it('GRF-C116 ext.wakePane types exactly the resume command once and answers started', async () => {
    hibernated.add(sleeper.paneId)
    const reply = call('runner', 'ext.wakePane', { paneId: sleeper.externalId, waitMs: 5000 })
    await new Promise((r) => setTimeout(r, 200))
    waking.end(sleeper.paneId, 'started')
    expect(await reply).toEqual({ ok: true, outcome: 'started' })
    expect(typed).toEqual([`${sleeper.paneId}: 'claude' --resume s1`])
  })

  it('ext.wakePane answers resume-failed when the agent did not start', async () => {
    hibernated.add(sleeper.paneId)
    const reply = call('runner', 'ext.wakePane', { paneId: sleeper.externalId, waitMs: 5000 })
    await new Promise((r) => setTimeout(r, 200))
    waking.end(sleeper.paneId, 'failed', 'its agent exited with code 1 before it started')
    expect(await reply).toEqual({ ok: true, outcome: 'resume-failed' })
  })

  it('ext.wakePane leaves the pane out of the waking set when the wake rejects', async () => {
    hibernated.add(sleeper.paneId)
    wakeRejects = true
    try {
      await call('runner', 'ext.wakePane', { paneId: sleeper.externalId, waitMs: 5000 })
    } finally {
      wakeRejects = false
    }
    expect(waking.has(sleeper.paneId)).toBe(false)
  })

  it('GRF-C117 ext.wakePane refuses an awake pane, a session held elsewhere and the manager, and ignores text', async () => {
    expect(
      await call('runner', 'ext.wakePane', { paneId: target.externalId, text: 'rm -rf ~' }),
    ).toMatchObject({
      error: 'not-hibernated',
    })
    hibernated.add(held.paneId)
    expect(
      await call('runner', 'ext.wakePane', { paneId: held.externalId, command: 'ls' }),
    ).toMatchObject({
      error: 'session-conflict',
    })
    expect(await call('runner', 'ext.wakePane', { paneId: manager.externalId })).toMatchObject({
      error: 'unknown-pane',
    })
    expect(
      (await call('limited', 'ext.wakePane', { paneId: target.externalId })).rpcError,
    ).toContain('needs-elevation: all-workspaces')
    expect(typed).toEqual([])
  })

  it('GRF-C119 background must be a boolean, and the seventh agent task in a minute is rate-limited', async () => {
    openTerminalIn.mockResolvedValue(started.externalId)
    expect(
      await call('runner', 'ext.runAgent', {
        workspaceId: 'w1',
        agent: 'claude',
        prompt: 'p',
        background: 'yes',
      }),
    ).toMatchObject({
      error: 'invalid-params',
    })
    for (let i = 0; i < AGENT_TASKS_PER_MINUTE; i++) {
      expect(
        await call('runner', 'ext.runAgent', {
          workspaceId: 'w1',
          agent: 'claude',
          prompt: 'p',
          background: true,
        }),
      ).toMatchObject({
        ok: true,
      })
    }
    expect(openTerminalIn.mock.calls[0][0]).toMatchObject({ backgroundTab: true })
    expect(
      await call('runner', 'ext.runAgent', { workspaceId: 'w1', agent: 'claude', prompt: 'p' }),
    ).toMatchObject({
      error: 'rate-limited',
    })
  })

  it('GRF-C183 continueFrom forks a session held by a live pane and resumes it once the agent exited', async () => {
    openTerminalIn.mockResolvedValue(started.externalId)
    await call('runner', 'ext.runAgent', {
      workspaceId: 'w1',
      agent: 'claude',
      prompt: 'implement',
    })
    openTerminalIn.mockReset()
    openTerminalIn.mockResolvedValue(target.externalId)
    resumeOf.mockResolvedValue({ resume: { agent: 'claude', id: 's1', cwd: dir }, held: true })
    expect(
      await call('runner', 'ext.runAgent', {
        workspaceId: 'w1',
        continueFrom: started.externalId,
        prompt: "fix it's tests",
        background: true,
      }),
    ).toMatchObject({ ok: true })
    expect(openTerminalIn.mock.calls[0][0]).toMatchObject({
      command: `'claude' --resume s1 --fork-session 'fix it'\\''s tests'`,
      cwd: dir,
      backgroundTab: true,
    })
    resumeOf.mockResolvedValue({ resume: { agent: 'claude', id: 's1', cwd: dir }, held: false })
    await call('runner', 'ext.runAgent', {
      workspaceId: 'w1',
      continueFrom: started.externalId,
      prompt: 'again',
    })
    expect(openTerminalIn.mock.calls[1][0]).toMatchObject({
      command: "'claude' --resume s1 again",
    })
  })

  it('GRF-C184 continueFrom refuses an unreached pane, no session and a missing folder, and ignores args', async () => {
    expect(
      await call('runner', 'ext.runAgent', {
        workspaceId: 'w1',
        continueFrom: twin.externalId,
        prompt: 'p',
      }),
    ).toMatchObject({
      error: 'not-reached',
    })
    openTerminalIn.mockResolvedValue(started.externalId)
    await call('runner', 'ext.runAgent', { workspaceId: 'w1', agent: 'claude', prompt: 'p' })
    openTerminalIn.mockReset()
    resumeOf.mockResolvedValue(null)
    expect(
      await call('runner', 'ext.runAgent', {
        workspaceId: 'w1',
        continueFrom: started.externalId,
        prompt: 'p',
      }),
    ).toMatchObject({
      error: 'no-session',
    })
    resumeOf.mockResolvedValue({
      resume: { agent: 'claude', id: 's1', cwd: join(dir, 'gone') },
      held: false,
    })
    expect(
      await call('runner', 'ext.runAgent', {
        workspaceId: 'w1',
        continueFrom: started.externalId,
        prompt: 'p',
      }),
    ).toMatchObject({
      error: 'resume-folder-missing',
    })
    resumeOf.mockResolvedValue({ resume: { agent: 'claude', id: 's1', cwd: dir }, held: false })
    openTerminalIn.mockResolvedValue(target.externalId)
    await call('runner', 'ext.runAgent', {
      workspaceId: 'w1',
      continueFrom: started.externalId,
      prompt: 'p',
      args: ['--dangerously-skip-permissions'],
      command: 'rm -rf ~',
    })
    expect(openTerminalIn.mock.calls.map((c) => c[0].command)).toEqual(["'claude' --resume s1 p"])
  })

  it('GRF-C120 ext.ask puts a question in the workspace window labelled with the extension and returns the pick', async () => {
    published.length = 0
    const reply = call('runner', 'ext.ask', {
      workspaceId: 'w1',
      question: 'Open a pull request?',
      choices: ['Open it', 'Stop here'],
    })
    await new Promise((r) => setTimeout(r, 200))
    const shown = published.at(-1)?.state.pending[0]
    expect(published.at(-1)?.windowId).toBe('7')
    expect(shown?.source).toEqual({ extension: 'Runner', workspaceId: 'w1' })
    questions()?.answer('7', shown?.id ?? '', { choices: [0], text: '' })
    expect(await reply).toEqual({
      ok: true,
      outcome: 'answered',
      reply: { choices: ['Open it'], text: '' },
    })
  })

  it('GRF-C121 a fourth open question, a long question, an unknown workspace and a closed connection', async () => {
    published.length = 0
    const open = [1, 2, 3].map((i) =>
      call('runner', 'ext.ask', { workspaceId: 'w1', question: `q${i}` }),
    )
    await new Promise((r) => setTimeout(r, 200))
    expect(await call('runner', 'ext.ask', { workspaceId: 'w1', question: 'q4' })).toMatchObject({
      error: 'too-many-questions',
    })
    for (const q of questions()?.stateFor('7').pending ?? []) questions()?.dismiss('7', q.id)
    await Promise.all(open)
    clock += 120_000
    const long = call('runner', 'ext.ask', { workspaceId: 'w1', question: 'x'.repeat(501) })
    await new Promise((r) => setTimeout(r, 200))
    const shown = questions()?.stateFor('7').pending[0]
    expect(shown?.question.length).toBe(500)
    questions()?.dismiss('7', shown?.id ?? '')
    expect(await long).toEqual({ ok: true, outcome: 'dismissed' })
    expect(await call('runner', 'ext.ask', { workspaceId: 'nope', question: 'q' })).toMatchObject({
      error: 'unknown-workspace',
    })
    void call('runner', 'ext.ask', { workspaceId: 'w1', question: 'pending when it stops' })
    await new Promise((r) => setTimeout(r, 200))
    expect(questions()?.stateFor('7').pending).toHaveLength(1)
    host.processes.stopAll()
    await vi.waitUntil(() => (questions()?.stateFor('7').pending.length ?? 0) === 0, {
      timeout: 5000,
      interval: 50,
    })
    expect(questions()?.stateFor('7').pending).toEqual([])
  })

  it('GRF-C122 no socket method lists, answers or dismisses an extension question', async () => {
    const { conn, close } = await paneConn(target)
    for (const method of [
      'question.answer',
      'question.dismiss',
      'question.list',
      'ext.answer',
      'ext.questions',
      'ask.answer',
    ]) {
      await expect(conn.sendRequest(method, {})).rejects.toThrow(
        /Unhandled method|not found|unknown/i,
      )
    }
    close()
  })

  it('ext.wakePane and continueFrom refuse a pane the extension did not open, such as one its hook reached', async () => {
    const human = registerPane({ windowId: '7', workspaceId: 'w1', paneId: 'pane-human-agent' })
    hibernated.add(human.paneId)
    expect(await call('runner', 'ext.wakePane', { paneId: human.externalId })).toMatchObject({
      error: 'not-reached',
    })
    expect(
      await call('runner', 'ext.runAgent', {
        workspaceId: 'w1',
        continueFrom: human.externalId,
        prompt: 'p',
      }),
    ).toMatchObject({
      error: 'not-reached',
    })
    expect(typed).toEqual([])
  })

  it('ext.ask needs drive-self', async () => {
    expect(
      (await call('limited', 'ext.ask', { workspaceId: 'w1', question: 'q' })).rpcError,
    ).toContain('needs-elevation: drive-self')
  })
})
