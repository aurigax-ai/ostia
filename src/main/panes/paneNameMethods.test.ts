import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlMethod, ControlMethodContext } from '../control/controlServer'

const methods = new Map<string, ControlMethod>()
vi.mock('../control/controlServer', () => ({
  registerControlMethod: (name: string, method: ControlMethod) => methods.set(name, method),
}))

const { markManager, registerPane } = await import('../control/idRegistry')
const { registerPaneNameMethods } = await import('./paneNameMethods')
const { forgetNames, nameOf, panesNamed } = await import('./paneNames')

const sandboxed = new Set<string>()
const confined = new Set<string>()
const reached = new Set<string>()
const agents = new Set<string>()
const tabs = new Map<string, string[]>()
registerPaneNameMethods({
  visible: async () => (workspaceId) => reached.has(workspaceId),
  isSandboxed: (workspaceId) => sandboxed.has(workspaceId),
  isConfined: (paneId) => confined.has(paneId),
  processPane: async (ref) => tabs.get(ref) ?? [],
  agentRunning: (paneId) => agents.has(paneId),
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
  tabs.clear()
  agents.clear()
  for (const pane of [me, peer, far, boss]) agents.add(pane.paneId)
})

describe('pane.name', () => {
  it('needs only drive-self and names the caller’s own pane', async () => {
    expect(methods.get('pane.name')?.cap).toBe('drive-self')
    expect(await name(me, { name: 'boss', desc: ' plans ' })).toEqual({
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
    expect(panesNamed('boss')).toEqual([])
  })

  it('refuses a name a pane the caller reaches holds, and names that holder', async () => {
    await name(peer, { name: 'boss' })
    await expect(name(me, { name: 'boss' })).rejects.toThrow(
      `name-taken: boss held by ${peer.externalId}`,
    )
    expect(nameOf('name-me')).toBeUndefined()
  })

  it('lets a pane outside the caller’s reach hold the same name', async () => {
    await name(far, { name: 'boss' })
    expect(await name(me, { name: 'boss' })).toMatchObject({ ok: true, name: 'boss' })
    expect(panesNamed('boss')).toEqual(['name-far', 'name-me'])
    reached.add('ws9')
    await expect(name(peer, { name: 'boss' })).rejects.toThrow('name-taken: boss held by')
  })

  it('ignores a holder a sandboxed caller does not confine', async () => {
    await name(peer, { name: 'boss' })
    sandboxed.add('ws1')
    expect(await name(me, { name: 'boss' })).toMatchObject({ ok: true })
    confined.add('name-peer')
    await expect(name(far, { name: 'boss' })).resolves.toMatchObject({ ok: true })
  })

  it('refuses the --name of a live tab in reach, and keeps the name it had', async () => {
    await name(me, { name: 'before' })
    tabs.set('worker-1', ['name-peer'])
    await expect(name(me, { name: 'worker-1' })).rejects.toThrow(
      'name-taken: worker-1 is the --name',
    )
    expect(nameOf('name-me')?.name).toBe('before')
    tabs.set('mine', ['name-me'])
    expect(await name(me, { name: 'mine' })).toMatchObject({ ok: true })
  })

  it('refuses a pane that is not an agent with its hooks running', async () => {
    agents.delete('name-me')
    await expect(name(me, { name: 'boss' })).rejects.toThrow('not-an-agent')
    expect(await name(me, { clear: true })).toEqual({ ok: true, paneId: me.externalId })
  })

  it('refuses a bad name, a bad description and the manager pane', async () => {
    await expect(name(me, { name: 'a b' })).rejects.toThrow('bad-name')
    await expect(name(me, { name: 'Boss' })).rejects.toThrow('bad-name')
    await expect(name(me, { name: 'ok', desc: 'a\nb' })).rejects.toThrow('bad-desc')
    await expect(name(boss, { name: 'ok' })).rejects.toThrow('not-available')
  })
})
