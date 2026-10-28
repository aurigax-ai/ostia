import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ControlMethodContext } from '../control/controlServer'
import type { PaneIdentity } from '../control/idRegistry'
import { type CoreLifecycle, coreLifecycle } from './agentCoreCall'
import { createPromptMail } from './agentMail'

const pi: PaneIdentity = {
  kind: 'pane',
  externalId: 'ext-pi',
  token: 't',
  windowId: '1',
  workspaceId: 'w1',
  paneId: 'p-pi',
}
const scope = { paneId: 'p-pi', windowId: '1', workspaceId: 'w1' }

const lifecycles: CoreLifecycle[] = []

afterEach(() => {
  for (const lifecycle of lifecycles.splice(0)) lifecycle.end()
})

function rig(
  answers: Record<string, unknown>,
  overrides: Partial<Parameters<typeof createPromptMail>[0]> = {},
) {
  const calls: { name: string; params: unknown; ctx: ControlMethodContext }[] = []
  const take = createPromptMail({
    identityOf: () => pi,
    sandboxed: () => false,
    isManagerSession: () => false,
    call: vi.fn(async (name: string, params: unknown, ctx: ControlMethodContext) => {
      calls.push({ name, params, ctx })
      const answer = answers[name]
      if (answer instanceof Error) throw answer
      return answer ?? { ok: true }
    }),
    ...overrides,
  })
  const lifecycle = coreLifecycle()
  lifecycles.push(lifecycle)
  return { calls, take: () => take(scope, lifecycle), lifecycle }
}

describe('createPromptMail', () => {
  it('takes the wrapped context as the Agent pane and acknowledges its lease once', async () => {
    const { calls, take } = rig({
      'bus.context': { text: '<ostia-bus-messages>hi</ostia-bus-messages>', lease: 'l1' },
    })
    const mail = await take()
    expect(mail?.text).toBe('<ostia-bus-messages>hi</ostia-bus-messages>')
    expect(calls.map((c) => c.name)).toEqual(['bus.context'])
    expect(calls[0]?.ctx.identity).toBe(pi)
    await mail?.ack()
    expect(calls.map((c) => [c.name, c.params])).toEqual([
      ['bus.context', {}],
      ['bus.ack', { lease: 'l1' }],
    ])
  })

  it('hands nothing for an empty inbox, a failed call or a text-less answer', async () => {
    expect(await rig({ 'bus.context': { text: null } }).take()).toBeNull()
    expect(await rig({ 'bus.context': new Error('boom') }).take()).toBeNull()
    expect(await rig({ 'bus.context': 'x' }).take()).toBeNull()
  })

  it('acknowledges nothing when the context carries no lease', async () => {
    const { calls, take } = rig({ 'bus.context': { text: 'too long to deliver here' } })
    const mail = await take()
    await mail?.ack()
    expect(calls.map((c) => c.name)).toEqual(['bus.context'])
  })

  it('calls nothing for a pane that is not the session’s, or in a sandboxed workspace', async () => {
    const other = rig({}, { identityOf: () => ({ ...pi, workspaceId: 'w2' }) })
    expect(await other.take()).toBeNull()
    const boxed = rig({}, { sandboxed: () => true })
    expect(await boxed.take()).toBeNull()
    expect(other.calls).toEqual([])
    expect(boxed.calls).toEqual([])
  })

  it('refuses the manager pane', async () => {
    const manager = rig({}, { identityOf: () => ({ ...pi, manager: true }) })
    expect(await manager.take()).toBeNull()
    expect(manager.calls).toEqual([])
  })

  it('ends the connection with the lifecycle so the bus can release the lease', async () => {
    const { calls, take, lifecycle } = rig({ 'bus.context': { text: 't', lease: 'l1' } })
    await take()
    const closed = vi.fn()
    calls[0]?.ctx.conn.onClose(closed)
    lifecycle.end()
    expect(closed).toHaveBeenCalledTimes(1)
  })
})
