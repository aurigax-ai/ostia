import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    artifactsDir: vi.fn().mockReturnValue(null),
    openArtifact: vi.fn().mockResolvedValue(true),
    fileScope: vi.fn().mockReturnValue({
      home: '/nonexistent-home',
      dataDirs: [],
      rules: { denyRead: [], allowRead: [] },
    }),
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

describe('dispatchGatewayMethod — fs.list / fs.read', () => {
  let root: string
  let outside: string
  const caps = ['read', 'notify']

  function filesDeps(
    rules = { denyRead: [] as string[], allowRead: [] as string[] },
    home = '/nonexistent-home',
    dataDirs: string[] = [],
  ) {
    return fakeDeps({
      listWorkspaces: vi
        .fn()
        .mockResolvedValue([
          { workspaceId: 'w1', name: 'api', kind: 'terminal', workDir: root, state: 'idle' },
        ]),
      fileScope: vi.fn().mockReturnValue({ home, dataDirs, rules }),
    })
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gw-files-'))
    outside = mkdtempSync(join(tmpdir(), 'gw-outside-'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'README.md'), 'hello')
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('fs.list lists the workspace root with kind, size and mtime', async () => {
    const res = await dispatchGatewayMethod(
      'fs.list',
      { sessionId: 'w1', path: '' },
      caps,
      filesDeps(),
    )
    expect(res.ok).toBe(true)
    const { entries } = (res as { result: { entries: Record<string, unknown>[] } }).result
    expect(entries.map((e) => [e.name, e.kind])).toEqual([
      ['leak', 'link'],
      ['README.md', 'file'],
      ['src', 'dir'],
    ])
    const readme = entries.find((e) => e.name === 'README.md')
    expect(readme?.size).toBe(5)
    expect(typeof readme?.mtime).toBe('number')
  })

  it('answers outside-workspace for .., an absolute path and a symlink pointing out', async () => {
    const deps = filesDeps()
    const cases: [string, Record<string, unknown>][] = [
      ['fs.list', { sessionId: 'w1', path: '..' }],
      ['fs.read', { sessionId: 'w1', path: '../secret.txt' }],
      ['fs.read', { sessionId: 'w1', path: join(outside, 'secret.txt') }],
      ['fs.list', { sessionId: 'w1', path: outside }],
      ['fs.read', { sessionId: 'w1', path: 'leak' }],
    ]
    for (const [method, params] of cases) {
      expect(await dispatchGatewayMethod(method, params, caps, deps)).toEqual({
        ok: false,
        code: -32602,
        message: 'outside-workspace',
      })
    }
  })

  it('answers not-found for a missing path', async () => {
    const deps = filesDeps()
    for (const method of ['fs.list', 'fs.read']) {
      expect(
        await dispatchGatewayMethod(method, { sessionId: 'w1', path: 'gone' }, caps, deps),
      ).toEqual({ ok: false, code: -32602, message: 'not-found' })
    }
  })

  it('fs.read returns UTF-8 text', async () => {
    const res = await dispatchGatewayMethod(
      'fs.read',
      { sessionId: 'w1', path: 'README.md' },
      caps,
      filesDeps(),
    )
    expect(res).toEqual({ ok: true, result: { text: 'hello', size: 5, truncated: false } })
  })

  it('fs.read returns at most 256 KB of a 300 KB file with truncated: true', async () => {
    writeFileSync(join(root, 'big.txt'), 'a'.repeat(300 * 1024))
    const res = await dispatchGatewayMethod(
      'fs.read',
      { sessionId: 'w1', path: 'big.txt', maxBytes: 10 * 1024 * 1024 },
      caps,
      filesDeps(),
    )
    const result = (res as { result: { text: string; size: number; truncated: boolean } }).result
    expect(result.text.length).toBe(256 * 1024)
    expect(result.size).toBe(300 * 1024)
    expect(result.truncated).toBe(true)
  })

  it('fs.read honours a smaller maxBytes', async () => {
    const res = await dispatchGatewayMethod(
      'fs.read',
      { sessionId: 'w1', path: 'README.md', maxBytes: 2 },
      caps,
      filesDeps(),
    )
    expect(res).toEqual({ ok: true, result: { text: 'he', size: 5, truncated: true } })
  })

  it('fs.read returns base64 for a binary file', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    writeFileSync(join(root, 'img.png'), bytes)
    const res = await dispatchGatewayMethod(
      'fs.read',
      { sessionId: 'w1', path: 'img.png' },
      caps,
      filesDeps(),
    )
    expect(res).toEqual({
      ok: true,
      result: { base64: bytes.toString('base64'), size: 6, truncated: false },
    })
  })

  it('keeps a path the workspace sandbox hides out of reach and out of listings', async () => {
    const deps = filesDeps({ denyRead: [join(realpathSync(root), 'src')], allowRead: [] })
    const listed = await dispatchGatewayMethod(
      'fs.list',
      { sessionId: 'w1', path: '.' },
      caps,
      deps,
    )
    const names = (listed as { result: { entries: { name: string }[] } }).result.entries.map(
      (e) => e.name,
    )
    expect(names).not.toContain('src')
    expect(
      await dispatchGatewayMethod('fs.list', { sessionId: 'w1', path: 'src' }, caps, deps),
    ).toEqual({ ok: false, code: -32602, message: 'outside-workspace' })
  })

  it('refuses a workspace whose folder is home, above home or holds Ostia’s data', async () => {
    const tooBroad = { ok: false, code: -32602, message: 'workspace-too-broad' }
    const cases = [
      filesDeps(undefined, root),
      filesDeps(undefined, join(root, 'src')),
      filesDeps(undefined, '/nonexistent-home', [join(root, 'src', 'ostia')]),
    ]
    for (const deps of cases) {
      expect(
        await dispatchGatewayMethod('fs.list', { sessionId: 'w1', path: '' }, caps, deps),
      ).toEqual(tooBroad)
      expect(
        await dispatchGatewayMethod('fs.read', { sessionId: 'w1', path: 'README.md' }, caps, deps),
      ).toEqual(tooBroad)
    }
  })

  it('never lists or reads credential files, even inside the workspace folder', async () => {
    const secrets = [
      '.ssh/id_ed25519',
      '.gnupg/private-keys-v1.d/key',
      '.aws/credentials',
      '.config/gh/hosts.yml',
      '.docker/config.json',
      '.cargo/credentials.toml',
      '.ostia/vault.json',
      'src/.netrc',
      'src/.git-credentials',
      'src/.npmrc',
      'src/.env',
      'src/.env.local',
    ]
    for (const secret of secrets) {
      mkdirSync(join(root, secret, '..'), { recursive: true })
      writeFileSync(join(root, secret), 'token')
    }
    writeFileSync(join(root, 'src', 'app.ts'), 'ok')
    symlinkSync(join(root, '.ssh', 'id_ed25519'), join(root, 'notes'))
    const deps = filesDeps()
    const names = async (path: string) => {
      const res = await dispatchGatewayMethod('fs.list', { sessionId: 'w1', path }, caps, deps)
      return (res as { result: { entries: { name: string }[] } }).result.entries.map((e) => e.name)
    }
    expect(await names('')).toEqual([
      '.cargo',
      '.config',
      '.docker',
      '.ostia',
      'leak',
      'notes',
      'README.md',
      'src',
    ])
    expect(await names('src')).toEqual(['app.ts'])
    expect(await names('.config')).toEqual([])
    expect(await names('.docker')).toEqual([])
    for (const path of [...secrets, '.ssh', 'notes', './src/../.aws/credentials']) {
      for (const method of ['fs.read', 'fs.list']) {
        expect(await dispatchGatewayMethod(method, { sessionId: 'w1', path }, caps, deps)).toEqual({
          ok: false,
          code: -32602,
          message: 'not-found',
        })
      }
    }
  })

  it('answers unknown-session for a workspace that is not open', async () => {
    expect(
      await dispatchGatewayMethod('fs.list', { sessionId: 'nope', path: '' }, caps, filesDeps()),
    ).toEqual({ ok: false, code: -32602, message: 'unknown-session' })
  })

  it('needs the read cap for both methods', async () => {
    for (const method of ['fs.list', 'fs.read']) {
      expect(
        await dispatchGatewayMethod(
          method,
          { sessionId: 'w1', path: 'README.md' },
          [],
          filesDeps(),
        ),
      ).toEqual({ ok: false, code: -32003, message: 'needs-elevation', data: { cap: 'read' } })
    }
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

describe('dispatchGatewayMethod — the artifacts root (contract v1.7)', () => {
  let folder: string
  let outside: string
  const caps = ['read']

  function deps(dir: string | null = folder) {
    return fakeDeps({
      listWorkspaces: vi
        .fn()
        .mockResolvedValue([
          { workspaceId: 'w1', name: 'api', kind: 'terminal', workDir: '/', state: 'idle' },
        ]),
      artifactsDir: vi.fn((id: string) => (id === 'w1' ? dir : null)),
    })
  }

  const call = (method: string, params: Record<string, unknown>, d = deps(), c = caps) =>
    dispatchGatewayMethod(method, { sessionId: 'w1', root: 'artifacts', ...params }, c, d)

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'gw-artifacts-'))
    outside = mkdtempSync(join(tmpdir(), 'gw-artifacts-out-'))
    writeFileSync(join(folder, 'report.md'), '# report')
    writeFileSync(join(folder, 'PAD.md'), 'pad')
    mkdirSync(join(folder, 'page', 'deep'), { recursive: true })
    writeFileSync(join(folder, 'page', 'index.html'), '<p>hi</p>')
    writeFileSync(join(folder, 'page', 'deep', 'hidden.js'), 'x')
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    symlinkSync(join(outside, 'secret.txt'), join(folder, 'leak.txt'))
    symlinkSync(outside, join(folder, 'out'))
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('lists regular files and folders of the artifact folder, never a symlink', async () => {
    const res = await call('fs.list', { path: '' })
    if (!res.ok) throw new Error(res.message)
    const { entries } = res.result as { entries: { name: string; kind: string; size: number }[] }
    expect(entries.map((e) => [e.name, e.kind])).toEqual([
      ['PAD.md', 'file'],
      ['page', 'dir'],
      ['report.md', 'file'],
    ])
    expect(entries[2].size).toBe(8)
  })

  it('lists one level down and nothing deeper', async () => {
    const page = await call('fs.list', { path: 'page' })
    expect(page.ok && page.result).toEqual({
      entries: [expect.objectContaining({ name: 'index.html', kind: 'file' })],
    })
    expect(await call('fs.list', { path: 'page/deep' })).toMatchObject({
      ok: false,
      message: 'not-found',
    })
    expect(await call('fs.read', { path: 'page/deep/hidden.js' })).toMatchObject({
      ok: false,
      message: 'not-found',
    })
  })

  it('reads a file as text, and a symlink or a path that leaves answers an error with no content', async () => {
    const read = await call('fs.read', { path: 'page/index.html' })
    expect(read.ok && read.result).toEqual({ text: '<p>hi</p>', size: 9, truncated: false })
    for (const path of [
      'leak.txt',
      'out/secret.txt',
      '../secret.txt',
      join(outside, 'secret.txt'),
    ]) {
      const res = await call('fs.read', { path })
      expect(res.ok, path).toBe(false)
      expect(JSON.stringify(res), path).not.toContain('nope')
    }
    expect(await call('fs.read', { path: 'leak.txt' })).toMatchObject({ message: 'not-found' })
    expect(await call('fs.read', { path: '../secret.txt' })).toMatchObject({
      message: 'outside-workspace',
    })
    expect(await call('fs.list', { path: 'out' })).toMatchObject({ message: 'not-found' })
  })

  it('reads a large file in slices with offset, as base64 past the start', async () => {
    const bytes = Buffer.alloc(300 * 1024, 0x61)
    bytes[262144] = 0x62
    writeFileSync(join(folder, 'big.txt'), bytes)
    const first = await call('fs.read', { path: 'big.txt' })
    expect(first.ok && first.result).toMatchObject({ size: 307200, truncated: true })
    expect(first.ok && (first.result as { text: string }).text).toHaveLength(262144)
    const rest = await call('fs.read', { path: 'big.txt', offset: 262144 })
    const result = rest.ok ? (rest.result as { base64: string; truncated: boolean }) : null
    expect(result?.truncated).toBe(false)
    const tail = Buffer.from(result?.base64 ?? '', 'base64')
    expect(tail).toHaveLength(307200 - 262144)
    expect(tail[0]).toBe(0x62)
    const past = await call('fs.read', { path: 'big.txt', offset: 999_999_999 })
    expect(past.ok && past.result).toMatchObject({ base64: '', size: 307200, truncated: false })
  })

  it('takes offset for the workspace root too', async () => {
    const d = fakeDeps({
      listWorkspaces: vi
        .fn()
        .mockResolvedValue([
          { workspaceId: 'w1', name: 'api', kind: 'terminal', workDir: folder, state: 'idle' },
        ]),
      fileScope: vi.fn().mockReturnValue({
        home: '/nonexistent-home',
        dataDirs: [],
        rules: { denyRead: [], allowRead: [] },
      }),
    })
    const res = await dispatchGatewayMethod(
      'fs.read',
      { sessionId: 'w1', path: 'report.md', offset: 2 },
      caps,
      d,
    )
    expect(res.ok && res.result).toEqual({
      base64: Buffer.from('report').toString('base64'),
      size: 8,
      truncated: false,
    })
  })

  it('answers an empty list for a workspace whose folder does not exist yet, and never makes it', async () => {
    const missing = join(folder, 'not-made')
    const res = await call('fs.list', { path: '' }, deps(missing))
    expect(res.ok && res.result).toEqual({ entries: [] })
    expect(existsSync(missing)).toBe(false)
    expect(await call('fs.read', { path: 'a.md' }, deps(missing))).toMatchObject({
      message: 'not-found',
    })
  })

  it('refuses an unknown root, an unknown workspace and a device without read', async () => {
    expect(await call('fs.list', { path: '', root: 'home' })).toMatchObject({
      ok: false,
      message: 'invalid-root',
    })
    expect(await call('fs.list', { path: '', sessionId: 'w9' })).toMatchObject({
      ok: false,
      message: 'unknown-session',
    })
    expect(await call('fs.list', { path: '' }, deps(null))).toMatchObject({ message: 'not-found' })
    for (const method of ['fs.list', 'fs.read']) {
      expect(await call(method, { path: 'report.md' }, deps(), ['notify'])).toMatchObject({
        ok: false,
        data: { cap: 'read' },
      })
    }
  })

  it('artifact.open opens one regular file of the folder on the desktop, with the command cap only', async () => {
    const d = deps()
    const withCommand = ['read', 'command']
    const res = await call('artifact.open', { path: 'page/index.html' }, d, withCommand)
    expect(res).toEqual({ ok: true, result: { ok: true } })
    expect(vi.mocked(d.openArtifact).mock.calls).toEqual([
      ['w1', join(folder, 'page', 'index.html')],
    ])
    expect(await call('artifact.open', { path: 'report.md' }, deps(), ['read'])).toMatchObject({
      ok: false,
      code: -32003,
      data: { cap: 'command' },
    })
  })

  it('artifact.open refuses what fs.read refuses, and opens nothing then', async () => {
    const d = deps()
    const withCommand = ['read', 'command']
    const cases: [Record<string, unknown>, string][] = [
      [{ path: 'leak.txt' }, 'not-found'],
      [{ path: 'out/secret.txt' }, 'not-found'],
      [{ path: 'page/deep/hidden.js' }, 'not-found'],
      [{ path: 'missing.md' }, 'not-found'],
      [{ path: '../secret.txt' }, 'outside-workspace'],
      [{ path: join(outside, 'secret.txt') }, 'outside-workspace'],
      [{ path: 'page' }, 'not-a-file'],
      [{ path: 'report.md', sessionId: 'w9' }, 'unknown-session'],
    ]
    for (const [params, message] of cases) {
      expect(await call('artifact.open', params, d, withCommand), message).toMatchObject({
        ok: false,
        code: -32602,
        message,
      })
    }
    expect(d.openArtifact).not.toHaveBeenCalled()
    expect(
      await call('artifact.open', { path: 'report.md' }, deps(null), withCommand),
    ).toMatchObject({
      message: 'not-found',
    })
  })

  it('has no write, rename or delete', async () => {
    for (const method of ['fs.write', 'fs.rename', 'fs.delete', 'pad.append', 'artifact.write']) {
      expect((await call(method, { path: 'report.md', text: 'x' })).ok, method).toBe(false)
    }
    expect(readFileSync(join(folder, 'report.md'), 'utf8')).toBe('# report')
  })
})
