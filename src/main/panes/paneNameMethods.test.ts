import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlMethod, ControlMethodContext } from '../control/controlServer'

const methods = new Map<string, ControlMethod>()
vi.mock('../control/controlServer', () => ({
  registerControlMethod: (name: string, method: ControlMethod) => methods.set(name, method),
}))

const { markManager, registerPane } = await import('../control/idRegistry')
const { registerPaneNameMethods } = await import('./paneNameMethods')
const { forgetNames, nameOf, paneNamed } = await import('./paneNames')

const sandboxed = new Set<string>()
const confined = new Set<string>()
const reached = new Set<string>()
registerPaneNameMethods({
  reach: { visible: async () => (workspaceId) => reached.has(workspaceId) },
  isSandboxed: (workspaceId) => sandboxed.has(workspaceId),
  isConfined: (paneId) => confined.has(paneId),
})

const me = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'name-me' })
const peer = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'name-peer' })
const far = registerPane({ windowId: 'w1', workspaceId: 'ws9', paneId: 'name-far' })
const boss = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'name-boss' })
markManager('name-boss')

function name(identity: typeof me, params: unknown): Promise<unknown> {
  const method = methods.get('pane.name')
  const ctx = { identity, authed: {}, conn: {} } as unknown as ControlMethodContext
  return Promise.resolve(method?.handler(params, ctx))
}

beforeEach(() => {
  forgetNames()
  sandboxed.clear()
  confined.clear()
  reached.clear()
})

describe('pane.name', () => {
  it('needs only drive-self and names the caller’s own pane', async () => {
    expect(methods.get('pane.name')?.cap).toBe('drive-self')
    expect(await name(me, { name: 'Boss', desc: ' plans ' })).toEqual({
      ok: true,
      paneId: me.externalId,
      name: 'boss',
      desc: 'plans',
    })
    expect(nameOf('name-me')).toEqual({ name: 'boss', desc: 'plans' })
  })

  it('clears the name, and refuses a clear that carries a name', async () => {
    await name(me, { name: 'boss' })
    await expect(name(me, { clear: true, name: 'x' })).rejects.toThrow('bad-request: clear')
    expect(await name(me, { clear: true })).toEqual({ ok: true, paneId: me.externalId })
    expect(paneNamed('boss')).toBeUndefined()
  })

  it('refuses a held name and says who holds it only when the caller reaches the holder', async () => {
    await name(peer, { name: 'boss' })
    await expect(name(me, { name: 'boss' })).rejects.toThrow(
      `name-taken: boss held by ${peer.externalId}`,
    )
    await name(far, { name: 'far-boss' })
    await expect(name(me, { name: 'far-boss' })).rejects.toThrow(
      'name-taken: far-boss held by another pane',
    )
    reached.add('ws9')
    await expect(name(me, { name: 'far-boss' })).rejects.toThrow(
      `name-taken: far-boss held by ${far.externalId}`,
    )
    expect(nameOf('name-me')).toBeUndefined()
  })

  it('hides a holder that a sandboxed caller does not confine', async () => {
    await name(peer, { name: 'boss' })
    sandboxed.add('ws1')
    await expect(name(me, { name: 'boss' })).rejects.toThrow('held by another pane')
    confined.add('name-peer')
    await expect(name(me, { name: 'boss' })).rejects.toThrow(`held by ${peer.externalId}`)
  })

  it('refuses a bad name, a bad description and the manager pane', async () => {
    await expect(name(me, { name: 'a b' })).rejects.toThrow('bad-name')
    await expect(name(me, { name: 'ok', desc: 'a\nb' })).rejects.toThrow('bad-desc')
    await expect(name(boss, { name: 'ok' })).rejects.toThrow('not-available')
  })
})
