import { describe, expect, it, vi } from 'vitest'
import type { CommandDescriptor, CommandResult } from '../../shared/types'
import { registerPane } from '../idRegistry'
import { type GatewayControlDeps, dispatchGatewayMethod } from './controlDispatch'

/** A minimal, fully-specified `CommandDescriptor` — every case below overrides just what it needs. */
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
    listSessions: vi.fn().mockResolvedValue([]),
    kanbanGet: vi.fn().mockReturnValue({ columns: [], cards: [] }),
    primaryWindowId: vi.fn().mockReturnValue('w1'),
    attachPhoneObserver: vi.fn().mockReturnValue(null),
    ptyResize: vi.fn(),
    ptyWrite: vi.fn(),
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

  it('rejects board.get without the board.read cap', async () => {
    const res = await dispatchGatewayMethod('board.get', {}, ['read'], fakeDeps())
    expect(res).toEqual({
      ok: false,
      code: -32003,
      message: 'needs-elevation',
      data: { cap: 'board.read' },
    })
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
  it('session.list wraps listSessions() as { sessions }', async () => {
    const sessions = [
      { sessionId: 's1', name: 'api', kind: 'terminal', workDir: '/x', state: 'idle' },
    ]
    const deps = fakeDeps({ listSessions: vi.fn().mockResolvedValue(sessions) })
    const res = await dispatchGatewayMethod('session.list', {}, ['read'], deps)
    expect(res).toEqual({ ok: true, result: { sessions } })
  })

  it('pane.list wraps listPanes() as { panes }, ignoring any sessionId filter param', async () => {
    const panes = [
      {
        paneId: 'ext-1',
        sessionId: 's1',
        kind: 'terminal',
        title: 'zsh',
        running: true,
        blockCount: 0,
      },
    ]
    const listPanes = vi.fn().mockResolvedValue(panes)
    const deps = fakeDeps({ listPanes })
    const res = await dispatchGatewayMethod('pane.list', { sessionId: 's1' }, ['read'], deps)
    expect(res).toEqual({ ok: true, result: { panes } })
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
      { windowId: 'w1', sessionId: '', paneId: null },
      'session.new',
      { a: 1 },
    )
  })

  it('resolves an explicit `target` pane externalId via idRegistry', async () => {
    const identity = registerPane({ windowId: 'w2', sessionId: 's2', paneId: 'p2' })
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
      { windowId: 'w2', sessionId: 's2', paneId: 'p2' },
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

    // Even a phone holding every contract-defined cap still can't reach it.
    const res = await dispatchGatewayMethod(
      'command.exec',
      { id: 'browser.new' },
      ['read', 'board.read', 'notify', 'command', 'input', 'board.write', 'destructive'],
      deps,
    )
    expect(res).toEqual({
      ok: false,
      code: -32003,
      message: 'needs-elevation',
      data: { cap: 'browse' },
    })
  })
})

describe('dispatchGatewayMethod — pane.info / cwd.get', () => {
  it('pane.info resolves the externalId and merges terminal state, defaulting absent fields', async () => {
    const identity = registerPane({ windowId: 'w1', sessionId: 's1', paneId: 'p-info' })
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
    const identity = registerPane({ windowId: 'w1', sessionId: 's1', paneId: 'p-nostate' })
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
    const identity = registerPane({ windowId: 'w1', sessionId: 's1', paneId: 'p-cwd' })
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

describe('dispatchGatewayMethod — board.get', () => {
  it('uses an explicit `scope` as the sessionId', async () => {
    const board = { columns: [{ id: 'todo', name: 'Todo' }], cards: [] }
    const kanbanGet = vi.fn().mockReturnValue(board)
    const res = await dispatchGatewayMethod(
      'board.get',
      { scope: 's-explicit' },
      ['board.read'],
      fakeDeps({ kanbanGet }),
    )
    expect(res).toEqual({ ok: true, result: board })
    expect(kanbanGet).toHaveBeenCalledWith('s-explicit')
  })

  it('falls back to the first known session when scope is omitted', async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValue([
        { sessionId: 's1', name: 'a', kind: 'terminal', workDir: '/x', state: 'idle' },
      ])
    const kanbanGet = vi.fn().mockReturnValue({ columns: [], cards: [] })
    const res = await dispatchGatewayMethod(
      'board.get',
      {},
      ['board.read'],
      fakeDeps({ listSessions, kanbanGet }),
    )
    expect(res.ok).toBe(true)
    expect(kanbanGet).toHaveBeenCalledWith('s1')
  })

  it('returns an empty board when there is no session at all', async () => {
    const res = await dispatchGatewayMethod(
      'board.get',
      {},
      ['board.read'],
      fakeDeps({ listSessions: vi.fn().mockResolvedValue([]) }),
    )
    expect(res).toEqual({ ok: true, result: { columns: [], cards: [] } })
  })
})
