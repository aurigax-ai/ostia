import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandDescriptor, CommandResult } from '../../shared/types'
import { registerPane } from '../idRegistry'
import { type GatewayControlDeps, dispatchGatewayMethod } from './controlDispatch'

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
