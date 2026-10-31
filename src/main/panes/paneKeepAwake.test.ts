import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../../shared/control/commands'
import type { ControlMethod, ControlMethodContext } from '../control/controlServer'

const methods = new Map<string, ControlMethod>()
vi.mock('../control/controlServer', () => ({
  registerControlMethod: (name: string, method: ControlMethod) => methods.set(name, method),
}))

const { markManager, registerPane } = await import('../control/idRegistry')
const { registerPaneKeepAwakeMethods } = await import('./paneKeepAwake')

const agents = new Set<string>()
const calls: { paneId: string | null; id: string; args: unknown; fromMain: unknown }[] = []
let outcome: CommandResult = { ok: true, result: { keepAwake: true } }

registerPaneKeepAwakeMethods({
  agentRunning: (paneId) => agents.has(paneId),
  execCommand: async (target, id, args, fromMain) => {
    calls.push({ paneId: target.paneId, id, args, fromMain })
    return outcome
  },
})

const me = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'kept-me' })
const boss = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'kept-boss' })
markManager('kept-boss')

function run(identity: typeof me, params: unknown): Promise<unknown> {
  const ctx = { identity, authed: {}, conn: {} } as unknown as ControlMethodContext
  return Promise.resolve(methods.get('pane.keepAwake')?.handler(params, ctx))
}

beforeEach(() => {
  agents.clear()
  calls.length = 0
  outcome = { ok: true, result: { keepAwake: true } }
  agents.add('kept-me')
})

describe('pane.keepAwake', () => {
  it('needs only drive-self and marks the caller’s own pane', async () => {
    expect(methods.get('pane.keepAwake')?.cap).toBe('drive-self')
    expect(await run(me, { on: true })).toEqual({
      ok: true,
      paneId: me.externalId,
      keepAwake: true,
    })
    expect(calls).toEqual([
      { paneId: 'kept-me', id: 'pane.keepAwake', args: { on: true }, fromMain: true },
    ])
  })

  it('ends the mark even when the agent is gone', async () => {
    agents.clear()
    outcome = { ok: true, result: { keepAwake: false } }
    expect(await run(me, { on: false })).toEqual({
      ok: true,
      paneId: me.externalId,
      keepAwake: false,
    })
  })

  it('refuses a pane with no running agent and sends nothing', async () => {
    agents.clear()
    await expect(run(me, { on: true })).rejects.toThrow(/^not-an-agent:/)
    expect(calls).toEqual([])
  })

  it('refuses the manager pane and a missing flag', async () => {
    agents.add('kept-boss')
    await expect(run(boss, { on: true })).rejects.toThrow(/^not-available:/)
    await expect(run(me, {})).rejects.toThrow('bad-request: on')
  })

  it('answers an error when the tab did not take the change', async () => {
    outcome = { ok: true, result: { keepAwake: false } }
    await expect(run(me, { on: true })).rejects.toThrow(/^not-kept:/)
  })
})
