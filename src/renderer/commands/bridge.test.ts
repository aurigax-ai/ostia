import type { CommandInvokeRequest } from '@shared/control/commands'
import { describe, expect, it, vi } from 'vitest'
import { wireCommandBridge } from './bridge'
import { registerPaneAgentCommands } from './core/paneAgentCommands'
import { registerPaneTabCommands } from './paneTabCommands'
import type { CommandContext } from './registry'
import { commands } from './registry'

describe('wireCommandBridge', () => {
  it('publishes exactly commands.describe() to main', () => {
    commands.register({ id: 'test.publish.echo', title: 'Echo', run: () => {} })

    wireCommandBridge()

    const expected = commands.describe()
    expect(expected.some((d) => d.id === 'test.publish.echo')).toBe(true)
    const publish = vi.mocked(window.ostia.commands.publish)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(expected)
  })

  it('routes the invoke request through execWith with a target-derived context', async () => {
    const run = vi.fn((_args: { x: number }, _ctx: CommandContext) => ({ ran: true }))
    commands.register({ id: 'test.invoke.cmd', title: 'Invoke', run })
    const execSpy = vi.spyOn(commands, 'execWith')

    wireCommandBridge()

    const onInvoke = vi.mocked(window.ostia.commands.onInvoke)
    expect(onInvoke).toHaveBeenCalledTimes(1)
    const handler = onInvoke.mock.calls[0][0]

    const req: CommandInvokeRequest = {
      id: 'test.invoke.cmd',
      args: { x: 1 },
      target: { windowId: 'w1', workspaceId: 's9', paneId: 'p9' },
    }
    const result = await handler(req)

    expect(execSpy).toHaveBeenCalledWith(
      { activeWorkspaceId: 's9', activePaneId: 'p9', target: req.target, origin: 'remote' },
      req.id,
      req.args,
    )

    expect(run).toHaveBeenCalledTimes(1)
    const [args, ctx] = run.mock.calls[0]
    expect(args).toEqual({ x: 1 })
    expect(ctx.activeWorkspaceId).toBe('s9')
    expect(ctx.activePaneId).toBe('p9')
    expect(ctx.target).toEqual(req.target)

    expect(result).toEqual({ ok: true, result: { ran: true } })

    execSpy.mockRestore()
  })

  it('maps a null-pane target to a null activePaneId', async () => {
    const run = vi.fn((_args: unknown, _ctx: CommandContext) => ({ ok: 1 }))
    commands.register({ id: 'test.invoke.nullpane', title: 'NullPane', run })

    wireCommandBridge()

    const handler = vi.mocked(window.ostia.commands.onInvoke).mock.calls[0][0]
    await handler({ id: 'test.invoke.nullpane', target: { workspaceId: 's2', paneId: null } })

    expect(run).toHaveBeenCalledTimes(1)
    const [, ctx] = run.mock.calls[0]
    expect(ctx.activeWorkspaceId).toBe('s2')
    expect(ctx.activePaneId).toBeNull()
  })

  it('resolves to an unknown-command error when the handler gets an unregistered id', async () => {
    wireCommandBridge()

    const handler = vi.mocked(window.ostia.commands.onInvoke).mock.calls[0][0]
    const result = await handler({
      id: 'does.not.exist',
      target: { workspaceId: 's1', paneId: 'p1' },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('unknown-command')
      expect(result.error.message).toContain('does.not.exist')
    }
  })

  it('hides a local command from main and refuses to run it for a socket caller', async () => {
    const run = vi.fn()
    commands.register({ id: 'test.local.only', title: 'Local', local: true, run })

    wireCommandBridge()

    expect(commands.describe().some((d) => d.id === 'test.local.only')).toBe(false)
    const handler = vi.mocked(window.ostia.commands.onInvoke).mock.calls[0][0]
    const result = await handler({
      id: 'test.local.only',
      target: { workspaceId: 's1', paneId: 'p1' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('unknown-command')
    expect(run).not.toHaveBeenCalled()
  })

  it('runs pane.tabPlan and pane.joinTab only for main itself, never for command.exec', async () => {
    registerPaneTabCommands()
    wireCommandBridge()

    const published = commands.describe().map((d) => d.id)
    expect(published).not.toContain('pane.tabPlan')
    expect(published).not.toContain('pane.joinTab')
    const handler = vi.mocked(window.ostia.commands.onInvoke).mock.calls[0][0]
    const target = { workspaceId: 's1', paneId: 'p1' }
    for (const id of ['pane.tabPlan', 'pane.joinTab']) {
      const viaSocket = await handler({ id, args: { paneIds: ['p1'], tab: 'x' }, target })
      expect(viaSocket.ok ? '' : viaSocket.error.code, id).toBe('unknown-command')
    }
    const fromMain = await handler({
      id: 'pane.tabPlan',
      args: { paneIds: [], tab: null },
      target: { workspaceId: '', paneId: null },
      fromMain: true,
    })
    expect(fromMain.ok ? '' : fromMain.error.message).not.toContain('unknown command')
  })

  it('runs pane.hibernate only for main itself, never for command.exec', async () => {
    registerPaneAgentCommands()
    wireCommandBridge()

    expect(commands.describe().map((d) => d.id)).not.toContain('pane.hibernate')
    const handler = vi.mocked(window.ostia.commands.onInvoke).mock.calls[0][0]
    const target = { workspaceId: 's1', paneId: 'p1' }
    const viaSocket = await handler({ id: 'pane.hibernate', args: { paneId: 'p2' }, target })
    expect(viaSocket.ok ? '' : viaSocket.error.code).toBe('unknown-command')
    const fromMain = await handler({
      id: 'pane.hibernate',
      args: { paneId: 'p2' },
      target,
      fromMain: true,
    })
    expect(fromMain.ok ? '' : fromMain.error.code).not.toBe('unknown-command')
  })
})
