import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlMethod, ControlMethodContext } from '../control/controlServer'

const dataHome = mkdtempSync(join(tmpdir(), 'ostia-watch-'))
process.env.XDG_DATA_HOME = dataHome

const methods = new Map<string, ControlMethod>()
vi.mock('../control/controlServer', () => ({
  registerControlMethod: (name: string, method: ControlMethod) => methods.set(name, method),
}))
const ensureCaps = vi.fn(async (..._args: unknown[]) => {})
vi.mock('../approvals/controlElevation', () => ({ ensureCaps }))

const { registerPaneWatchMethods } = await import('./paneWatchMethods')
const { dropWatchesOf, flushBus, resetBus, watchesOf } = await import('../agents/busStore')
const { markManager, registerPane } = await import('../control/idRegistry')

const boss = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'wm-boss' })
const worker = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'wm-worker' })
const second = registerPane({ windowId: 'w1', workspaceId: 'ws1', paneId: 'wm-second' })
const faraway = registerPane({ windowId: 'w1', workspaceId: 'ws9', paneId: 'wm-faraway' })

const sandboxed = new Set<string>()
const confined = new Set<string>()

registerPaneWatchMethods({
  processPane: async () => [],
  visible: async () => () => true,
  inScope: async (ctx, workspaceId) => ctx.identity.workspaceId === workspaceId,
  isChild: () => false,
  isSandboxed: (workspaceId) => sandboxed.has(workspaceId),
  isConfined: (paneId) => confined.has(paneId),
})

function watch(identity: typeof boss, params: unknown) {
  const method = methods.get('pane.watch')
  if (!method) throw new Error('no pane.watch')
  return method.handler(params, {
    identity,
    authed: {},
    conn: { onClose: () => ({ dispose: () => {} }) },
  } as unknown as ControlMethodContext) as Promise<{
    watching: { pane: string; until: string[]; open: boolean }[]
  }>
}

beforeEach(async () => {
  await resetBus()
  rmSync(join(dataHome, 'ostia'), { recursive: true, force: true })
  sandboxed.clear()
  confined.clear()
  ensureCaps.mockClear()
})

afterAll(async () => {
  await flushBus()
  rmSync(dataHome, { recursive: true, force: true })
})

describe('pane.watch', () => {
  it('answers the watch list as the store holds it, with the default states', async () => {
    const res = await watch(boss, { panes: [worker.externalId] })
    expect(res.watching).toEqual([
      { pane: worker.externalId, until: ['done', 'waiting', 'error', 'exited'], open: true },
    ])
    expect(watchesOf(boss.externalId)).toHaveLength(1)
  })

  it('takes the states asked for, again to change them, and several panes at once', async () => {
    await watch(boss, { panes: [worker.externalId], until: ['command', 'command', 'done'] })
    const res = await watch(boss, {
      panes: [worker.externalId, second.externalId],
      until: ['error'],
    })
    expect(res.watching.map((w) => [w.pane, w.until])).toEqual([
      [worker.externalId, ['error']],
      [second.externalId, ['error']],
    ])
  })

  it('stops watching the panes named with off, or everything with off alone', async () => {
    await watch(boss, { panes: [worker.externalId, second.externalId] })
    const one = await watch(boss, { panes: [worker.externalId], off: true })
    expect(one.watching.map((w) => w.pane)).toEqual([second.externalId])
    const none = await watch(boss, { off: true })
    expect(none.watching).toEqual([])
  })

  it('keeps one subscriber’s list apart from another’s', async () => {
    await watch(boss, { panes: [worker.externalId] })
    await watch(second, { panes: [worker.externalId], off: true })
    expect(watchesOf(boss.externalId)).toHaveLength(1)
  })

  it('forgets a watch when either pane closes', async () => {
    await watch(boss, { panes: [worker.externalId] })
    dropWatchesOf(worker.externalId)
    expect(watchesOf(boss.externalId)).toEqual([])
    await watch(boss, { panes: [worker.externalId] })
    dropWatchesOf(boss.externalId)
    expect(watchesOf(boss.externalId)).toEqual([])
  })

  it.each([
    [{}, 'bad-request: panes'],
    [{ panes: [] }, 'bad-request: panes'],
    [{ panes: ['worker'], until: [] }, 'bad-request: until'],
    [{ panes: ['worker'], until: ['finished'] }, 'bad-request: until finished'],
    [{ panes: ['worker'], off: 'yes' }, 'bad-request: off'],
  ])('refuses %j', async (params, message) => {
    await expect(watch(boss, params)).rejects.toThrow(message)
  })

  it('refuses watching itself, an unknown pane and more than 32 panes', async () => {
    await expect(watch(boss, { panes: [boss.externalId] })).rejects.toThrow(
      'a pane cannot watch itself',
    )
    await expect(watch(boss, { panes: ['nope'] })).rejects.toThrow('unknown-pane')
    const many = Array.from(
      { length: 33 },
      (_, i) =>
        registerPane({
          windowId: 'w1',
          workspaceId: 'ws1',
          paneId: `wm-many-${i}`,
        }).externalId,
    )
    await expect(watch(boss, { panes: many })).rejects.toThrow('too-many')
  })

  it('asks the reach of a read, with all-workspaces outside it, and stores nothing when denied', async () => {
    await watch(boss, { panes: [worker.externalId, faraway.externalId] })
    expect(ensureCaps).toHaveBeenCalledWith(
      {},
      boss,
      ['read-other-pane'],
      'pane.watch',
      expect.any(String),
    )
    expect(ensureCaps).toHaveBeenCalledWith(
      {},
      boss,
      ['read-other-pane', 'all-workspaces'],
      'pane.watch',
      expect.any(String),
    )
    await resetBus()
    rmSync(join(dataHome, 'ostia'), { recursive: true, force: true })
    ensureCaps.mockRejectedValueOnce(new Error('denied: read-other-pane'))
    await expect(watch(boss, { panes: [worker.externalId] })).rejects.toThrow('denied')
    expect(watchesOf(boss.externalId)).toEqual([])
  })

  it('keeps a sandboxed pane to confined panes of its workspace, and hides the manager', async () => {
    sandboxed.add('ws1')
    await expect(watch(boss, { panes: [worker.externalId] })).rejects.toThrow('sandboxed')
    confined.add(worker.paneId)
    expect((await watch(boss, { panes: [worker.externalId] })).watching).toHaveLength(1)
    sandboxed.clear()
    const manager = registerPane({ windowId: 'w1', workspaceId: 'mgr', paneId: 'wm-manager' })
    markManager('wm-manager')
    await expect(watch(boss, { panes: [manager.externalId] })).rejects.toThrow('unknown-pane')
  })
})
