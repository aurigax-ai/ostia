import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandDescriptor, CommandResult } from '../../shared/types'
import { registerPane } from '../idRegistry'
import {
  AGENT_ENTER_DELAY_MS,
  type GatewayControlDeps,
  dispatchGatewayMethod,
} from './controlDispatch'

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent' },
  ipcMain: { handle: vi.fn() },
  webContents: { fromId: vi.fn() },
}))

const { createApprovals } = await import('../approvals')
const { createQuestions } = await import('../questions')
const { createAskHub } = await import('../asks')
const { askPermission } = await import('../permissionAsk')

function descriptor(overrides: Partial<CommandDescriptor> & { id: string }): CommandDescriptor {
  return {
    title: overrides.id,
    category: null,
    hidden: false,
    argsSchema: null,
    resultSchema: null,
    capabilities: ['drive-self'],
    target: 'active',
    ...overrides,
  }
}

function fakeDeps(overrides: Partial<GatewayControlDeps> = {}): GatewayControlDeps {
  return {
    execCommand: vi.fn().mockResolvedValue({ ok: true, result: 'did-it' } as CommandResult),
    listCommandsFor: vi.fn().mockReturnValue([]),
    getTerminalState: vi.fn().mockReturnValue(undefined),
    listPanes: vi.fn().mockResolvedValue([]),
    listWorkspaces: vi.fn().mockResolvedValue([]),
    listWorkspaceGroups: vi.fn().mockResolvedValue([]),
    primaryWindowId: vi.fn().mockReturnValue('w1'),
    attachPhoneObserver: vi.fn().mockReturnValue(null),
    ptyResize: vi.fn(),
    ptyWrite: vi.fn(),
    listAsks: vi.fn().mockReturnValue([]),
    answerAsk: vi.fn().mockReturnValue('unknown-ask'),
    agentRunning: vi.fn().mockReturnValue(false),
    ...overrides,
  }
}

describe('dispatchGatewayMethod — cap gating', () => {
  it('rejects session.list/pane.list/command.list/pane.info/cwd.get without the read cap', async () => {
    const deps = fakeDeps()
    for (const method of ['session.list', 'pane.list', 'command.list', 'pane.info', 'cwd.get']) {
      const res = await dispatchGatewayMethod(method, { paneId: 'x' }, [], deps)
      expect(res).toEqual({
        ok: false,
        code: -32003,
        message: 'needs-elevation',
        data: { cap: 'read' },
      })
    }
  })

  it('rejects command.exec without the command cap', async () => {
    const res = await dispatchGatewayMethod('command.exec', { id: 'x' }, ['read'], fakeDeps())
    expect(res).toEqual({
      ok: false,
      code: -32003,
      message: 'needs-elevation',
      data: { cap: 'command' },
    })
  })

  it('never lets the input cap run command.exec, even for a default drive-self command', async () => {
    const deps = fakeDeps({
      listCommandsFor: vi.fn().mockReturnValue([descriptor({ id: 'pane.splitRight' })]),
    })
    const res = await dispatchGatewayMethod(
      'command.exec',
      { id: 'pane.splitRight' },
      ['read', 'notify', 'input'],
      deps,
    )
    expect(res).toEqual({
      ok: false,
      code: -32003,
      message: 'needs-elevation',
      data: { cap: 'command' },
    })
    expect(deps.execCommand).not.toHaveBeenCalled()
  })

  it('board.get and board.update are no longer gateway methods', async () => {
    for (const method of ['board.get', 'board.update']) {
      const res = await dispatchGatewayMethod(method, {}, ['read', 'notify', 'command'], fakeDeps())
      expect(res).toEqual({ ok: false, code: -32601, message: `method not found: ${method}` })
    }
  })

  it('an unknown method is a JSON-RPC method-not-found error, cap-check notwithstanding', async () => {
    const res = await dispatchGatewayMethod(
      'pty.attach',
      {},
      ['read', 'command', 'input'],
      fakeDeps(),
    )
    expect(res).toEqual({ ok: false, code: -32601, message: 'method not found: pty.attach' })
  })
})

describe('dispatchGatewayMethod — session.list / pane.list / command.list', () => {
  it('session.list keeps the phone contract: workspaces go out as { sessions } with sessionId', async () => {
    const workspaces = [
      { workspaceId: 'w1', name: 'api', kind: 'terminal', workDir: '/x', state: 'idle' },
    ]
    const deps = fakeDeps({ listWorkspaces: vi.fn().mockResolvedValue(workspaces) })
    const res = await dispatchGatewayMethod('session.list', {}, ['read'], deps)
    expect(res).toEqual({
      ok: true,
      result: {
        sessions: [
          { sessionId: 'w1', name: 'api', kind: 'terminal', workDir: '/x', state: 'idle' },
        ],
      },
    })
  })

  it('session.list carries a grouped workspace’s group as { id, name } and none otherwise', async () => {
    const workspaces = [
      {
        workspaceId: 'w1',
        name: 'api',
        kind: 'terminal',
        workDir: '/x',
        state: 'idle',
        groupId: 'g1',
      },
      { workspaceId: 'w2', name: 'web', kind: 'terminal', workDir: '/y', state: 'idle' },
    ]
    const groups = [{ groupId: 'g1', name: 'Backend', collapsed: false, workspaceIds: ['w1'] }]
    const deps = fakeDeps({
      listWorkspaces: vi.fn().mockResolvedValue(workspaces),
      listWorkspaceGroups: vi.fn().mockResolvedValue(groups),
    })
    const res = await dispatchGatewayMethod('session.list', {}, ['read'], deps)
    expect(res).toEqual({
      ok: true,
      result: {
        sessions: [
          {
            sessionId: 'w1',
            name: 'api',
            kind: 'terminal',
            workDir: '/x',
            state: 'idle',
            group: { id: 'g1', name: 'Backend' },
          },
          { sessionId: 'w2', name: 'web', kind: 'terminal', workDir: '/y', state: 'idle' },
        ],
      },
    })
  })

  it('session.list shows a renamed group’s new name on the next call', async () => {
    const workspaces = [
      {
        workspaceId: 'w1',
        name: 'api',
        kind: 'terminal',
        workDir: '/x',
        state: 'idle',
        groupId: 'g1',
      },
    ]
    const listWorkspaceGroups = vi
      .fn()
      .mockResolvedValueOnce([
        { groupId: 'g1', name: 'Old', collapsed: false, workspaceIds: ['w1'] },
      ])
      .mockResolvedValueOnce([
        { groupId: 'g1', name: 'New', collapsed: false, workspaceIds: ['w1'] },
      ])
    const deps = fakeDeps({
      listWorkspaces: vi.fn().mockResolvedValue(workspaces),
      listWorkspaceGroups,
    })
    const groupOf = async () => {
      const res = await dispatchGatewayMethod('session.list', {}, ['read'], deps)
      return res.ok ? (res.result as { sessions: { group?: unknown }[] }).sessions[0]?.group : null
    }
    expect(await groupOf()).toEqual({ id: 'g1', name: 'Old' })
    expect(await groupOf()).toEqual({ id: 'g1', name: 'New' })
  })

  it('pane.list wraps listPanes() as { panes } with the contract’s sessionId field', async () => {
    const pane = { paneId: 'ext-1', kind: 'terminal', title: 'zsh', running: true, blockCount: 0 }
    const listPanes = vi.fn().mockResolvedValue([{ ...pane, workspaceId: 'w1' }])
    const deps = fakeDeps({ listPanes })
    const res = await dispatchGatewayMethod('pane.list', { sessionId: 'w1' }, ['read'], deps)
    expect(res).toEqual({ ok: true, result: { panes: [{ ...pane, sessionId: 'w1' }] } })
    expect(listPanes).toHaveBeenCalledWith()
  })

  it('command.list wraps listCommandsFor(primaryWindowId()) as { commands }', async () => {
    const commands = [descriptor({ id: 'pane.splitRight' })]
    const listCommandsFor = vi.fn().mockReturnValue(commands)
    const deps = fakeDeps({
      listCommandsFor,
      primaryWindowId: vi.fn().mockReturnValue('w-primary'),
    })
    const res = await dispatchGatewayMethod('command.list', {}, ['read'], deps)
    expect(res).toEqual({ ok: true, result: { commands } })
    expect(listCommandsFor).toHaveBeenCalledWith('w-primary')
  })

  it('command.list returns no commands when there is no primary window', async () => {
    const deps = fakeDeps({ primaryWindowId: vi.fn().mockReturnValue(undefined) })
    const res = await dispatchGatewayMethod('command.list', {}, ['read'], deps)
    expect(res).toEqual({ ok: true, result: { commands: [] } })
  })
})

describe('dispatchGatewayMethod — command.exec', () => {
  it('executes a DEFAULT-capability command against the primary window with no target given', async () => {
    const desc = descriptor({ id: 'session.new', capabilities: ['drive-self'] })
    const execCommand = vi.fn().mockResolvedValue({ ok: true, result: undefined })
    const deps = fakeDeps({
      listCommandsFor: vi.fn().mockReturnValue([desc]),
      primaryWindowId: vi.fn().mockReturnValue('w1'),
      execCommand,
    })

    const res = await dispatchGatewayMethod(
      'command.exec',
      { id: 'session.new', args: { a: 1 } },
      ['command'],
      deps,
    )

    expect(res).toEqual({ ok: true, result: { ok: true, result: undefined } })
    expect(execCommand).toHaveBeenCalledWith(
      { windowId: 'w1', workspaceId: '', paneId: null },
      'session.new',
      { a: 1 },
    )
  })

  it('hands the app the inner id of a pane named in args by its external id', async () => {
    const identity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-args' })
    const desc = descriptor({ id: 'pane.splitRight' })
    const execCommand = vi.fn().mockResolvedValue({ ok: true, result: undefined })
    const deps = fakeDeps({
      listCommandsFor: vi.fn().mockReturnValue([desc]),
      primaryWindowId: vi.fn().mockReturnValue('w1'),
      execCommand,
    })

    await dispatchGatewayMethod(
      'command.exec',
      { id: 'pane.splitRight', args: { paneId: identity.externalId } },
      ['command'],
      deps,
    )
    expect(execCommand).toHaveBeenCalledWith(
      { windowId: 'w1', workspaceId: '', paneId: null },
      'pane.splitRight',
      { paneId: 'p-args' },
    )

    const res = await dispatchGatewayMethod(
      'command.exec',
      { id: 'pane.splitRight', args: { paneId: 'nope' } },
      ['command'],
      deps,
    )
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining('unknown-pane: nope') })
    expect(execCommand).toHaveBeenCalledTimes(1)
  })

  it('resolves an explicit `target` pane externalId via idRegistry', async () => {
    const identity = registerPane({ windowId: 'w2', workspaceId: 's2', paneId: 'p2' })
    const desc = descriptor({ id: 'pane.splitRight' })
    const execCommand = vi.fn().mockResolvedValue({ ok: true, result: undefined })
    const deps = fakeDeps({ listCommandsFor: vi.fn().mockReturnValue([desc]), execCommand })

    const res = await dispatchGatewayMethod(
      'command.exec',
      { id: 'pane.splitRight', target: identity.externalId },
      ['command'],
      deps,
    )

    expect(res.ok).toBe(true)
    expect(execCommand).toHaveBeenCalledWith(
      { windowId: 'w2', workspaceId: 's2', paneId: 'p2' },
      'pane.splitRight',
      undefined,
    )
  })

  it('an unresolvable target is a hard invalid-params error, not a silent default', async () => {
    const desc = descriptor({ id: 'pane.splitRight' })
    const deps = fakeDeps({ listCommandsFor: vi.fn().mockReturnValue([desc]) })

    const res = await dispatchGatewayMethod(
      'command.exec',
      { id: 'pane.splitRight', target: 'no-such-external-id' },
      ['command'],
      deps,
    )

    expect(res).toEqual({ ok: false, code: -32602, message: 'unknown pane target' })
  })

  it('an unknown command id comes back as a normal (ok:true) CommandResult failure', async () => {
    const deps = fakeDeps({ listCommandsFor: vi.fn().mockReturnValue([]) })
    const res = await dispatchGatewayMethod('command.exec', { id: 'nope' }, ['command'], deps)
    expect(res).toEqual({
      ok: true,
      result: { ok: false, error: { code: 'unknown-command', message: "unknown command 'nope'" } },
    })
  })

  it('missing command id is an invalid-params error', async () => {
    const res = await dispatchGatewayMethod('command.exec', {}, ['command'], fakeDeps())
    expect(res).toEqual({ ok: false, code: -32602, message: 'missing command id' })
  })

  it('a command requiring the internal destructive capability needs the phone destructive cap', async () => {
    const desc = descriptor({ id: 'pane.close', capabilities: ['destructive'] })
    const deps = fakeDeps({ listCommandsFor: vi.fn().mockReturnValue([desc]) })

    const denied = await dispatchGatewayMethod(
      'command.exec',
      { id: 'pane.close' },
      ['command'],
      deps,
    )
    expect(denied).toEqual({
      ok: false,
      code: -32003,
      message: 'needs-elevation',
      data: { cap: 'destructive' },
    })

    const allowed = await dispatchGatewayMethod(
      'command.exec',
      { id: 'pane.close' },
      ['command', 'destructive'],
      deps,
    )
    expect(allowed.ok).toBe(true)
  })

  it('a command requiring an elevated internal cap with no phone equivalent is always out of reach', async () => {
    const desc = descriptor({ id: 'browser.new', capabilities: ['browse'] })
    const deps = fakeDeps({ listCommandsFor: vi.fn().mockReturnValue([desc]) })

    const res = await dispatchGatewayMethod(
      'command.exec',
      { id: 'browser.new' },
      ['read', 'notify', 'command', 'input', 'destructive'],
      deps,
    )
    expect(res).toEqual({
      ok: false,
      code: -32003,
      message: 'needs-elevation',
      data: { cap: 'browse' },
    })
  })

  it('a DEFAULT-capability command with no phone-facing equivalent is still blocked (escalation fix)', async () => {
    const desc = descriptor({ id: 'process.spawn', capabilities: ['process'] })
    const deps = fakeDeps({ listCommandsFor: vi.fn().mockReturnValue([desc]) })
    const res = await dispatchGatewayMethod(
      'command.exec',
      { id: 'process.spawn' },
      ['command'],
      deps,
    )
    expect(res).toEqual({
      ok: false,
      code: -32003,
      message: 'needs-elevation',
      data: { cap: 'process' },
    })
  })

  it('pane.close (kill-pane) is unreachable to a phone even with every contract cap', async () => {
    const desc = descriptor({ id: 'pane.close', capabilities: ['kill-pane'] })
    const deps = fakeDeps({ listCommandsFor: vi.fn().mockReturnValue([desc]) })
    const res = await dispatchGatewayMethod(
      'command.exec',
      { id: 'pane.close' },
      ['read', 'notify', 'command', 'input', 'destructive'],
      deps,
    )
    expect(res).toEqual({
      ok: false,
      code: -32003,
      message: 'needs-elevation',
      data: { cap: 'kill-pane' },
    })
  })

  it('a command requiring the internal notify capability needs the phone notify cap', async () => {
    const desc = descriptor({ id: 'notify.send', capabilities: ['notify'] })
    const deps = fakeDeps({ listCommandsFor: vi.fn().mockReturnValue([desc]) })

    const denied = await dispatchGatewayMethod(
      'command.exec',
      { id: 'notify.send' },
      ['command'],
      deps,
    )
    expect(denied).toEqual({
      ok: false,
      code: -32003,
      message: 'needs-elevation',
      data: { cap: 'notify' },
    })

    const allowed = await dispatchGatewayMethod(
      'command.exec',
      { id: 'notify.send' },
      ['command', 'notify'],
      deps,
    )
    expect(allowed.ok).toBe(true)
  })
})

describe('dispatchGatewayMethod — pane.info / cwd.get', () => {
  it('pane.info resolves the externalId and merges terminal state, defaulting absent fields', async () => {
    const identity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-info' })
    const getTerminalState = vi.fn().mockReturnValue({
      paneId: 'p-info',
      generation: 2,
      cwd: '/x',
      running: true,
      blockCount: 4,
      lastExitCode: 1,
    })
    const deps = fakeDeps({ getTerminalState })

    const res = await dispatchGatewayMethod(
      'pane.info',
      { paneId: identity.externalId },
      ['read'],
      deps,
    )

    expect(res).toEqual({
      ok: true,
      result: {
        paneId: identity.externalId,
        generation: 2,
        cwd: '/x',
        running: true,
        blockCount: 4,
        lastExitCode: 1,
      },
    })
    expect(getTerminalState).toHaveBeenCalledWith('p-info')
  })

  it('pane.info defaults generation/running/blockCount when there is no terminal-state snapshot', async () => {
    const identity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-nostate' })
    const res = await dispatchGatewayMethod(
      'pane.info',
      { paneId: identity.externalId },
      ['read'],
      fakeDeps(),
    )
    expect(res).toEqual({
      ok: true,
      result: {
        paneId: identity.externalId,
        generation: 0,
        cwd: undefined,
        running: false,
        blockCount: 0,
        lastExitCode: undefined,
      },
    })
  })

  it('pane.info with an unknown paneId is invalid-params', async () => {
    const res = await dispatchGatewayMethod('pane.info', { paneId: 'ghost' }, ['read'], fakeDeps())
    expect(res).toEqual({ ok: false, code: -32602, message: 'unknown paneId' })
  })

  it('cwd.get resolves the pane and returns its terminal-state cwd', async () => {
    const identity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'p-cwd' })
    const getTerminalState = vi.fn().mockReturnValue({ cwd: '/here' })
    const res = await dispatchGatewayMethod(
      'cwd.get',
      { paneId: identity.externalId },
      ['read'],
      fakeDeps({ getTerminalState }),
    )
    expect(res).toEqual({ ok: true, result: { cwd: '/here' } })
  })

  it('cwd.get returns null cwd for an unknown paneId (never throws)', async () => {
    const res = await dispatchGatewayMethod('cwd.get', { paneId: 'ghost' }, ['read'], fakeDeps())
    expect(res).toEqual({ ok: true, result: { cwd: null } })
  })
})

describe('dispatchGatewayMethod — asks and agent replies', () => {
  const RESPOND = ['read', 'notify', 'respond']

  function setup() {
    const pane = registerPane({ windowId: '7', workspaceId: 'ws-asks', paneId: 'p-asks' })
    const created: unknown[] = []
    const resolved: unknown[] = []
    const questions = createQuestions({
      publish: () => true,
      now: () => 1000,
      opened: (request) => hub.questionOpened(request),
      settled: (id, outcome) => hub.settled(id, outcome),
    })
    const approvals = createApprovals({
      mode: () => 'ask',
      publish: () => true,
      grant: vi.fn(),
      revoke: vi.fn(),
      always: () => true,
      now: () => 2000,
      timeoutMs: 60_000,
      reveal: vi.fn(),
      opened: (request) => hub.approvalOpened(request),
      settled: (id, outcome) => hub.settled(id, outcome),
    })
    const hub = createAskHub({
      questions: () => questions,
      approvals: () => approvals,
      identity: (paneId) => (paneId === 'p-asks' ? pane : undefined),
      created: (ask) => created.push(ask),
      resolved: (r) => resolved.push(r),
    })
    const deps = fakeDeps({ listAsks: hub.list, answerAsk: hub.answer })
    const conn = { onClose: () => ({ dispose: () => {} }) }
    const ctx = { identity: pane, conn } as unknown as Parameters<typeof askPermission>[1]
    const question = () => {
      const ticket = questions.ask({
        externalId: pane.externalId,
        windowId: '7',
        paneId: 'p-asks',
        question: 'Which database?',
        context: 'Adding the refunds table',
        choices: ['staging', 'production'],
        mode: 'single',
      })
      if (!ticket.ok) throw new Error(ticket.error)
      return ticket
    }
    const approval = () =>
      approvals.request({
        externalId: pane.externalId,
        windowId: '7',
        paneId: 'p-asks',
        workspaceId: 'ws-asks',
        caps: ['shell'],
        action: 'command.exec agent.resume',
        detail: '{}',
      })
    const permission = (phoneCanAnswer = true) =>
      askPermission(
        { agent: 'claude', tool: 'Bash', detail: 'rm -rf node_modules', always: true },
        ctx,
        { questions: () => questions, phoneCanAnswer: () => phoneCanAnswer },
      )
    const list = async () => {
      const res = await dispatchGatewayMethod('ask.list', {}, ['read'], deps)
      return (res as { result: { asks: Record<string, unknown>[] } }).result.asks
    }
    return { pane, deps, created, resolved, question, approval, permission, list, hub, questions }
  }

  it('ask.list shapes a question, an approval and a permission request', async () => {
    const t = setup()
    t.question()
    void t.approval()
    void t.permission()
    const asks = await t.list()
    expect(asks).toEqual([
      {
        askId: expect.stringMatching(/^question-/),
        sessionId: 'ws-asks',
        paneId: t.pane.externalId,
        kind: 'question',
        title: 'Which database?',
        detail: 'Adding the refunds table',
        choices: [
          { id: '0', label: 'staging', tone: 'neutral' },
          { id: '1', label: 'production', tone: 'neutral' },
        ],
        allowText: true,
        since: 1000,
      },
      {
        askId: expect.stringMatching(/^question-/),
        sessionId: 'ws-asks',
        paneId: t.pane.externalId,
        kind: 'permission',
        agent: 'claude',
        title: 'Bash: rm -rf node_modules',
        detail: 'rm -rf node_modules',
        choices: [
          { id: 'once', label: 'Allow once', tone: 'primary' },
          { id: 'always', label: 'Always allow', tone: 'neutral' },
          { id: 'deny', label: 'Deny', tone: 'danger' },
        ],
        allowText: false,
        since: 1000,
      },
      {
        askId: expect.stringMatching(/^approval-/),
        sessionId: 'ws-asks',
        paneId: t.pane.externalId,
        kind: 'approval',
        title: 'command.exec agent.resume',
        detail: '{}',
        choices: [
          { id: 'once', label: 'Allow once', tone: 'primary' },
          { id: 'session', label: 'Allow for this pane', tone: 'neutral' },
          { id: 'always', label: 'Always allow', tone: 'neutral' },
          { id: 'deny', label: 'Deny', tone: 'danger' },
        ],
        allowText: false,
        since: 2000,
      },
    ])
    expect(t.created).toHaveLength(3)
  })

  it('ask.answer routes a question’s choice and text to questions.answer', async () => {
    const t = setup()
    const ticket = t.question()
    const res = await dispatchGatewayMethod(
      'ask.answer',
      { askId: ticket.id, choiceId: '1', text: 'after the backup' },
      RESPOND,
      t.deps,
    )
    expect(res).toEqual({ ok: true, result: { ok: true } })
    expect(await ticket.outcome).toEqual({
      outcome: 'answered',
      choices: ['production'],
      text: 'after the backup',
    })
  })

  it('ask.answer routes an approval to approvals.answer', async () => {
    const t = setup()
    const outcome = t.approval()
    const [ask] = await t.list()
    await dispatchGatewayMethod(
      'ask.answer',
      { askId: ask?.askId, choiceId: 'session' },
      RESPOND,
      t.deps,
    )
    expect(await outcome).toBe('session')
  })

  it('ask.answer routes a permission request back to the waiting hook', async () => {
    const t = setup()
    const decision = t.permission()
    const [ask] = await t.list()
    await dispatchGatewayMethod(
      'ask.answer',
      { askId: ask?.askId, choiceId: 'always' },
      RESPOND,
      t.deps,
    )
    expect(await decision).toEqual({ decision: 'always' })
  })

  it('answers unknown-ask once the phone answered the ask', async () => {
    const t = setup()
    const ticket = t.question()
    const answer = () =>
      dispatchGatewayMethod('ask.answer', { askId: ticket.id, choiceId: '0' }, RESPOND, t.deps)
    expect((await answer()).ok).toBe(true)
    expect(await answer()).toEqual({ ok: false, code: -32602, message: 'unknown-ask' })
    expect(t.resolved).toEqual([{ askId: ticket.id, outcome: 'answered' }])
  })

  it('resolves the ask for the phone when the desktop answers it', async () => {
    const t = setup()
    const ticket = t.question()
    expect(t.questions.answer('7', ticket.id, { choices: [1], text: '' })).toBe(true)
    expect(t.resolved).toEqual([{ askId: ticket.id, outcome: 'answered' }])
    expect(await t.list()).toEqual([])
    expect(
      await dispatchGatewayMethod(
        'ask.answer',
        { askId: ticket.id, choiceId: '0' },
        RESPOND,
        t.deps,
      ),
    ).toEqual({ ok: false, code: -32602, message: 'unknown-ask' })
  })

  it('refuses a choice the ask does not offer', async () => {
    const t = setup()
    void t.permission()
    const [ask] = await t.list()
    const res = await dispatchGatewayMethod(
      'ask.answer',
      { askId: ask?.askId, choiceId: 'forever' },
      RESPOND,
      t.deps,
    )
    expect(res).toEqual({ ok: false, code: -32602, message: 'invalid-answer' })
  })

  it('never lists a sandbox card, which only the desktop answers', async () => {
    const t = setup()
    const approvals = createApprovals({
      mode: () => 'ask',
      publish: () => true,
      grant: vi.fn(),
      revoke: vi.fn(),
      always: () => true,
      now: () => 1,
      timeoutMs: 60_000,
      reveal: vi.fn(),
      opened: (request) => t.hub.approvalOpened(request),
    })
    void approvals.request({
      externalId: t.pane.externalId,
      windowId: '7',
      paneId: 'p-asks',
      workspaceId: 'ws-asks',
      caps: [],
      action: 'reach example.com',
      detail: '',
      kind: 'sandbox-domain',
      subject: 'example.com',
    })
    expect(t.created).toEqual([])
  })

  it('keeps destructive and credentials cards on the desktop: never listed, never answered', async () => {
    const t = setup()
    for (const cap of ['destructive', 'credentials'] as const) {
      const approvals = createApprovals({
        mode: () => 'ask',
        publish: () => true,
        grant: vi.fn(),
        revoke: vi.fn(),
        always: () => true,
        now: () => 1,
        timeoutMs: 60_000,
        reveal: vi.fn(),
        opened: (request) => t.hub.approvalOpened(request),
      })
      const hub = createAskHub({
        questions: () => null,
        approvals: () => approvals,
        identity: () => t.pane,
        created: (ask) => t.created.push(ask),
        resolved: vi.fn(),
      })
      const outcome = approvals.request({
        externalId: t.pane.externalId,
        windowId: '7',
        paneId: 'p-asks',
        workspaceId: 'ws-asks',
        caps: [cap],
        action: `command.exec needs ${cap}`,
        detail: '{}',
      })
      const [pendingCard] = approvals.open()
      const deps = fakeDeps({ listAsks: hub.list, answerAsk: hub.answer })
      expect((await dispatchGatewayMethod('ask.list', {}, ['read'], deps)) as unknown).toEqual({
        ok: true,
        result: { asks: [] },
      })
      expect(
        await dispatchGatewayMethod(
          'ask.answer',
          { askId: pendingCard?.request.id, choiceId: 'once' },
          RESPOND,
          deps,
        ),
      ).toEqual({ ok: false, code: -32602, message: 'unknown-ask' })
      expect(approvals.open()).toHaveLength(1)
      approvals.answer('7', pendingCard?.request.id ?? '', 'deny')
      expect(await outcome).toBe('deny')
    }
    expect(t.created).toEqual([])
  })

  it('needs respond for ask.answer, agent.prompt and agent.interrupt', async () => {
    const t = setup()
    for (const method of ['ask.answer', 'agent.prompt', 'agent.interrupt']) {
      const res = await dispatchGatewayMethod(
        method,
        { askId: 'question-1', paneId: t.pane.externalId, text: 'go', key: 'esc' },
        ['read', 'notify', 'command', 'input', 'destructive'],
        t.deps,
      )
      expect(res).toEqual({
        ok: false,
        code: -32003,
        message: 'needs-elevation',
        data: { cap: 'respond' },
      })
    }
  })

  describe('agent.prompt / agent.interrupt', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('answers not-an-agent for a pane that runs no agent', async () => {
      const pane = registerPane({ windowId: '7', workspaceId: 'ws', paneId: 'p-shell' })
      const deps = fakeDeps({ agentRunning: vi.fn().mockReturnValue(false) })
      for (const [method, params] of [
        ['agent.prompt', { paneId: pane.externalId, text: 'hi' }],
        ['agent.interrupt', { paneId: pane.externalId, key: 'esc' }],
        ['agent.prompt', { paneId: 'nope', text: 'hi' }],
      ] as const) {
        expect(await dispatchGatewayMethod(method, params, RESPOND, deps)).toEqual({
          ok: false,
          code: -32602,
          message: 'not-an-agent',
        })
      }
      expect(deps.ptyWrite).not.toHaveBeenCalled()
    })

    it('agent.prompt pastes the text and presses Enter while the agent still runs', async () => {
      const pane = registerPane({ windowId: '7', workspaceId: 'ws', paneId: 'p-agent' })
      const deps = fakeDeps({ agentRunning: vi.fn().mockReturnValue(true) })
      const res = await dispatchGatewayMethod(
        'agent.prompt',
        { paneId: pane.externalId, text: 'fix the\ntests\u0007' },
        RESPOND,
        deps,
      )
      expect(res).toEqual({ ok: true, result: { ok: true } })
      expect(deps.ptyWrite).toHaveBeenCalledWith('p-agent', '\x1b[200~fix the\ntests\x1b[201~')
      vi.advanceTimersByTime(AGENT_ENTER_DELAY_MS)
      expect(deps.ptyWrite).toHaveBeenLastCalledWith('p-agent', '\r')
    })

    it('agent.prompt skips Enter when the agent stopped before it', async () => {
      const pane = registerPane({ windowId: '7', workspaceId: 'ws', paneId: 'p-agent-2' })
      const agentRunning = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
      const deps = fakeDeps({ agentRunning })
      await dispatchGatewayMethod(
        'agent.prompt',
        { paneId: pane.externalId, text: 'go' },
        RESPOND,
        deps,
      )
      vi.advanceTimersByTime(AGENT_ENTER_DELAY_MS)
      expect(deps.ptyWrite).toHaveBeenCalledTimes(1)
    })

    it('agent.interrupt sends Escape or Ctrl+C and nothing else', async () => {
      const pane = registerPane({ windowId: '7', workspaceId: 'ws', paneId: 'p-agent-3' })
      const ptyWrite = vi.fn()
      const deps = fakeDeps({ agentRunning: vi.fn().mockReturnValue(true), ptyWrite })
      const send = (key: string) =>
        dispatchGatewayMethod('agent.interrupt', { paneId: pane.externalId, key }, RESPOND, deps)
      await send('esc')
      await send('ctrl-c')
      expect(await send('toString')).toEqual({ ok: false, code: -32602, message: 'unknown key' })
      expect(ptyWrite.mock.calls).toEqual([
        ['p-agent-3', '\x1b'],
        ['p-agent-3', '\x03'],
      ])
    })
  })
})
