import { describe, expect, it, vi } from 'vitest'
import type { ExtensionCaller, OpenTerminalOptions } from '../../shared/extensions'
import type { ConfirmRequest, OpenTerminalResult, ToolRun } from '../sdk'
import { type SshDeps, sshCommands } from './commands'
import { CONNECT_USAGE, SHOW_USAGE } from './strings'

const RESOLVED = ['user dev', 'hostname 10.0.0.5', 'port 2200', 'proxyjump b1', ''].join('\n')

function ran(stdout: string): ToolRun {
  return { code: 0, stdout, stderr: '', missing: false, timedOut: false }
}

function setup(run: SshDeps['run'] = async () => ran(RESOLVED)) {
  const deps = {
    discover: vi.fn(() => ({ hosts: ['db', 'web'], truncated: false })),
    run: vi.fn(run),
    confirm: vi.fn<(req: ConfirmRequest) => Promise<boolean>>(async () => true),
    openTerminal: vi.fn<(opts: OpenTerminalOptions) => Promise<OpenTerminalResult>>(async () => ({
      ok: true,
      paneId: 'pane-ssh',
    })),
  }
  return { deps, commands: sshCommands(deps) }
}

function paneCaller(extra: Partial<ExtensionCaller> = {}): ExtensionCaller {
  return { kind: 'pane', paneId: 'pane-1', workspaceId: 'ws-1', capabilities: [], ...extra }
}

function userCaller(extra: Partial<ExtensionCaller> = {}): ExtensionCaller {
  return { kind: 'user', paneId: 'pane-1', workspaceId: 'ws-1', capabilities: [], ...extra }
}

function expectNothingHappened(deps: ReturnType<typeof setup>['deps']): void {
  expect(deps.run).not.toHaveBeenCalled()
  expect(deps.confirm).not.toHaveBeenCalled()
  expect(deps.openTerminal).not.toHaveBeenCalled()
}

describe('ssh connect', () => {
  it('SSH-C11 refuses options, separators, extra or missing destinations and unsafe characters', async () => {
    const refused = [
      ['-oProxyCommand=x', 'db'],
      ['-o', 'ProxyCommand=x', 'db'],
      ['-A', 'db'],
      ['--', 'db'],
      ['db', 'web'],
      [],
      ['db;reboot'],
      ['db%h'],
      ['d\u0007b'],
      ['-db'],
      ['dev@-db'],
    ]
    for (const argv of refused) {
      const { deps, commands } = setup()
      const result = await commands.connect({ argv }, userCaller())
      expect(result, argv.join(' ')).toEqual({
        ok: false,
        error: 'invalid-args',
        message: CONNECT_USAGE,
      })
      expectNothingHappened(deps)
    }
  })

  it('SSH-C12 refuses bad ports, ports on the destination, IPv6 and URI forms, and bad hop lists', async () => {
    const nineHops = Array.from({ length: 9 }, (_, i) => `b${i}`).join(',')
    const refused = [
      ['-p', '0', 'db'],
      ['-p', '65536', 'db'],
      ['-p', 'abc', 'db'],
      ['-p', 'db'],
      ['dev@db:2222'],
      ['[::1]'],
      ['ssh://dev@db'],
      ['-J', 'b1,,b2', 'db'],
      ['-J', 'b1:99999', 'db'],
      ['-J', 'b1:', 'db'],
      ['-J', nineHops, 'db'],
      ['-J', 'db'],
    ]
    for (const argv of refused) {
      const { deps, commands } = setup()
      const result = await commands.connect({ argv }, userCaller())
      expect(result, argv.join(' ')).toMatchObject({ ok: false, error: 'invalid-args' })
      expectNothingHappened(deps)
    }
  })

  it('SSH-C13 opens the session for the human beside their pane without asking', async () => {
    const { deps, commands } = setup()
    const result = await commands.connect({ argv: ['dev@db'] }, userCaller())
    expect(result).toEqual({
      ok: true,
      data: { approved: true, command: 'ssh -- dev@db', paneId: 'pane-ssh' },
    })
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(deps.run).toHaveBeenCalledWith(['-G', '--', 'dev@db'])
    expect(deps.openTerminal).toHaveBeenCalledTimes(1)
    expect(deps.openTerminal).toHaveBeenCalledWith({
      command: ['ssh', '--', 'dev@db'],
      workspaceId: 'ws-1',
      afterPaneId: 'pane-1',
      title: 'dev@db',
    })
  })

  it('SSH-C14 reports a terminal that could not be opened, with the command', async () => {
    const { deps, commands } = setup()
    deps.openTerminal.mockResolvedValue({
      ok: false,
      error: 'not-opened',
      message: 'no workspace to open it in',
    })
    const result = await commands.connect({ argv: ['db'] }, userCaller())
    expect(result).toMatchObject({
      ok: false,
      error: 'not-opened',
      data: { approved: true, command: 'ssh -- db' },
    })
    expect(result.ok === false && result.message).toContain('no workspace to open it in')
  })

  it('SSH-C15 asks the human with the command, the resolved target and its hop, then opens beside the caller', async () => {
    const { deps, commands } = setup()
    const result = await commands.connect({ argv: ['db'] }, paneCaller({ locale: 'en' }))
    expect(deps.confirm).toHaveBeenCalledTimes(1)
    const asked = deps.confirm.mock.calls[0][0]
    expect(asked.title).toBe('Open SSH connection')
    expect(asked.message).toContain('db')
    expect(asked.detail).toContain('ssh -- db')
    expect(asked.detail).toContain('dev@10.0.0.5:2200')
    expect(asked.detail).toContain('b1')
    expect(asked).toMatchObject({ confirmLabel: 'Connect', cancelLabel: 'Deny' })
    expect(asked).not.toHaveProperty('hostTerminal')
    expect(deps.openTerminal).toHaveBeenCalledWith({
      command: ['ssh', '--', 'db'],
      workspaceId: 'ws-1',
      afterPaneId: 'pane-1',
      title: 'db',
    })
    expect(result).toEqual({
      ok: true,
      data: { approved: true, command: 'ssh -- db', paneId: 'pane-ssh' },
    })
  })

  it('SSH-C16 opens nothing and says so when the human denies', async () => {
    const { deps, commands } = setup()
    deps.confirm.mockResolvedValue(false)
    const result = await commands.connect({ argv: ['db'] }, paneCaller())
    expect(result).toMatchObject({
      ok: false,
      error: 'denied',
      data: { approved: false, command: 'ssh -- db' },
    })
    expect(deps.openTerminal).not.toHaveBeenCalled()
  })

  it('SSH-C17 names the -J hops in the confirm instead of the hops from the ssh config', async () => {
    const { deps, commands } = setup()
    await commands.connect({ argv: ['-J', 'edge', 'db'] }, paneCaller())
    const detail = deps.confirm.mock.calls[0][0].detail ?? ''
    expect(detail).toContain('ssh -J edge -- db')
    expect(detail).toMatch(/Through: edge$/m)
    expect(detail).not.toContain('b1')
  })

  it('SSH-C22 fails with ssh-missing when ssh is not on PATH, asking and opening nothing', async () => {
    const missing = async (): Promise<ToolRun> => ({
      code: null,
      stdout: '',
      stderr: 'spawn ssh ENOENT',
      missing: true,
      timedOut: false,
    })
    for (const command of ['show', 'connect'] as const) {
      const { deps, commands } = setup(missing)
      const result = await commands[command]({ argv: ['db'] }, paneCaller())
      expect(result).toMatchObject({ ok: false, error: 'ssh-missing' })
      expect(result.ok === false && result.message).toContain('OpenSSH')
      expect(deps.confirm).not.toHaveBeenCalled()
      expect(deps.openTerminal).not.toHaveBeenCalled()
    }
  })

  it('SSH-C23 fails with resolve-failed and the first clipped error line when ssh -G fails or times out', async () => {
    const long = `bad config ${'x'.repeat(400)}`
    const failing = async (): Promise<ToolRun> => ({
      code: 255,
      stdout: '',
      stderr: `${long}\nsecond line\n`,
      missing: false,
      timedOut: false,
    })
    const failed = setup(failing)
    const result = await failed.commands.connect({ argv: ['db'] }, paneCaller())
    expect(result).toMatchObject({ ok: false, error: 'resolve-failed' })
    const message = result.ok === false ? (result.message ?? '') : ''
    expect(message).toContain('bad config')
    expect(message).not.toContain('second line')
    expect(message).not.toContain('x'.repeat(241))
    expect(failed.deps.confirm).not.toHaveBeenCalled()
    expect(failed.deps.openTerminal).not.toHaveBeenCalled()

    const slow = setup(async () => ({
      code: null,
      stdout: '',
      stderr: '',
      missing: false,
      timedOut: true,
    }))
    const timedOut = await slow.commands.connect({ argv: ['db'] }, paneCaller())
    expect(timedOut).toMatchObject({ ok: false, error: 'resolve-failed' })
    expect(slow.deps.confirm).not.toHaveBeenCalled()
    expect(slow.deps.openTerminal).not.toHaveBeenCalled()
  })

  it('SSH-C25 asks in zh-Hant when the caller uses a Chinese locale', async () => {
    const { deps, commands } = setup()
    await commands.connect({ argv: ['db'] }, paneCaller({ locale: 'zh-TW' }))
    expect(deps.confirm.mock.calls[0][0]).toMatchObject({
      title: '開啟 SSH 連線',
      confirmLabel: '連線',
      cancelLabel: '拒絕',
    })
  })

  it('SSH-C26 uses English for a locale without strings and for a caller without one', async () => {
    const french = setup()
    await french.commands.connect({ argv: ['db'] }, paneCaller({ locale: 'fr' }))
    expect(french.deps.confirm.mock.calls[0][0]).toMatchObject({
      title: 'Open SSH connection',
      confirmLabel: 'Connect',
      cancelLabel: 'Deny',
    })

    const none = setup()
    none.deps.confirm.mockResolvedValue(false)
    const denied = await none.commands.connect({ argv: ['db'] }, paneCaller())
    expect(denied.ok === false && denied.message).toBe(
      'the human denied the connection; nothing was opened',
    )
  })
})

describe('ssh ls and show', () => {
  it('SSH-C21 refuses show without exactly one plain alias and never runs ssh', async () => {
    for (const argv of [[], ['db', 'web'], ['-x'], ['a;b'], ['dev@db']]) {
      const { deps, commands } = setup()
      const result = await commands.show({ argv }, paneCaller())
      expect(result, argv.join(' ')).toEqual({
        ok: false,
        error: 'invalid-args',
        message: SHOW_USAGE,
      })
      expect(deps.run).not.toHaveBeenCalled()
    }
  })

  it('SSH-C24 refuses a sandboxed caller before reading, resolving, asking or opening', async () => {
    for (const command of ['ls', 'show', 'connect'] as const) {
      for (const caller of [paneCaller({ sandboxed: true }), userCaller({ sandboxed: true })]) {
        const { deps, commands } = setup()
        const result = await commands[command]({ argv: ['db'] }, caller)
        expect(result).toMatchObject({ ok: false, error: 'sandboxed' })
        expect(deps.discover).not.toHaveBeenCalled()
        expectNothingHappened(deps)
      }
    }
  })
})
