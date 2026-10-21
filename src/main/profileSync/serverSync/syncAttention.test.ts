import { describe, expect, it, vi } from 'vitest'
import type { ServerSyncStatus, SyncAttention } from '../../../shared/profileSync/serverSync'
import { createSyncAttention, IDLE_SCAN_MS, MAX_SCAN_MS, PENDING_SCAN_MS } from './syncAttention'

const STATUS: ServerSyncStatus = {
  state: 'ready',
  host: 'h',
  linking: false,
  linkApproved: false,
  linkCodes: [],
  joins: [],
  recoveryStale: false,
  wrapRefused: null,
  changedDevices: [],
}

type Approvals = { ok: true; approvals: never[] } | { ok: false; error: 'unreachable' }

const ask = (id: string): never =>
  ({
    id,
    deviceId: `dev-${id}`,
    deviceName: 'Watch',
    deviceCreatedAt: 1,
    createdAt: 9,
    expiresAt: 99,
  }) as never

function setup(saved: string[] = []) {
  const stored = { ids: saved }
  const state = {
    signedIn: true,
    syncCalls: 0,
    status: STATUS,
    approvals: { ok: true, approvals: [] } as Approvals,
  }
  const publish = vi.fn<(items: SyncAttention[]) => void>()
  const notify = vi.fn<(item: SyncAttention) => void>()
  const watch = createSyncAttention({
    active: () => state.signedIn,
    announced: {
      load: () => stored.ids,
      save: (ids) => {
        stored.ids = ids
      },
    },
    syncStatus: async () => {
      state.syncCalls += 1
      return state.status
    },
    approvals: async () => state.approvals,
    publish,
    notify,
  })
  return { state, publish, notify, watch, stored, saved }
}

describe('sync attention', () => {
  it('SYA-C100 lists join requests, approvals and changed devices', async () => {
    const { state, watch } = setup()
    state.status = {
      ...STATUS,
      joins: [{ deviceId: 'd3', name: 'Tablet', code: 'AAAAA-BBBBB', createdAt: 7 }],
      changedDevices: [{ id: 'd5', name: 'Laptop', until: 500 }],
    }
    state.approvals = { ok: true, approvals: [ask('a1')] }
    const items = await watch.scan()
    expect(items.map((i) => i.id)).toEqual(['join:d3', 'changed:d5:500', 'approval:a1'])
    expect(items.at(-1)).toMatchObject({ deviceId: 'dev-a1', createdAt: 9 })
  })

  it('SYA-C101 notifies once per item and again only after it went away', async () => {
    const { state, notify, watch } = setup()
    state.approvals = { ok: true, approvals: [ask('a1')] }
    await watch.scan()
    await watch.scan()
    expect(notify).toHaveBeenCalledTimes(1)
    state.approvals = { ok: true, approvals: [] }
    await watch.scan()
    state.approvals = { ok: true, approvals: [ask('a1')] }
    await watch.scan()
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('SYA-C102 publishes only when the list changes', async () => {
    const { state, publish, watch } = setup()
    await watch.scan()
    expect(publish).not.toHaveBeenCalled()
    state.approvals = { ok: true, approvals: [ask('a1')] }
    await watch.scan()
    await watch.scan()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('SYA-C103 keeps the list and stays quiet while the server is unreachable', async () => {
    const { state, publish, notify, watch } = setup()
    state.approvals = { ok: true, approvals: [ask('a1')] }
    await watch.scan()
    state.approvals = { ok: false, error: 'unreachable' }
    expect(await watch.scan()).toHaveLength(1)
    state.approvals = { ok: true, approvals: [ask('a1')] }
    await watch.scan()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('SYA-C104 empties the list when signed out', async () => {
    const { state, publish, watch } = setup()
    state.approvals = { ok: true, approvals: [ask('a1')] }
    await watch.scan()
    state.signedIn = false
    expect(await watch.scan()).toEqual([])
    expect(publish).toHaveBeenLastCalledWith([])
  })

  it('SYA-C105 does not notify again after a restart for an item it already announced', async () => {
    const first = setup()
    first.state.approvals = { ok: true, approvals: [ask('a1')] }
    await first.watch.scan()
    expect(first.notify).toHaveBeenCalledTimes(1)
    const restarted = setup(first.stored.ids)
    restarted.state.approvals = { ok: true, approvals: [ask('a1'), ask('a2')] }
    await restarted.watch.scan()
    expect(restarted.notify).toHaveBeenCalledTimes(1)
    expect(restarted.notify).toHaveBeenCalledWith(expect.objectContaining({ id: 'approval:a2' }))
    expect(restarted.stored.ids.sort()).toEqual(['approval:a1', 'approval:a2'])
  })

  it('SYA-C106 asks the server nothing while the server method is off or signed out', async () => {
    const { state, watch } = setup()
    state.signedIn = false
    await watch.scan()
    expect(state.syncCalls).toBe(0)
  })

  it('SYA-C107 polls every 8 seconds while something waits and every minute otherwise', async () => {
    const { state, watch } = setup()
    await watch.scan()
    expect(watch.delay()).toBe(IDLE_SCAN_MS)
    state.approvals = { ok: true, approvals: [ask('a1')] }
    await watch.scan()
    expect(watch.delay()).toBe(PENDING_SCAN_MS)
  })

  it('SYA-C108 backs off exponentially on errors up to a cap and recovers on success', async () => {
    const { state, watch } = setup()
    state.approvals = { ok: false, error: 'unreachable' }
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      await watch.scan()
      delays.push(watch.delay())
    }
    expect(delays).toEqual([
      IDLE_SCAN_MS,
      IDLE_SCAN_MS * 2,
      IDLE_SCAN_MS * 4,
      IDLE_SCAN_MS * 8,
      MAX_SCAN_MS,
      MAX_SCAN_MS,
      MAX_SCAN_MS,
    ])
    state.approvals = { ok: true, approvals: [] }
    await watch.scan()
    expect(watch.delay()).toBe(IDLE_SCAN_MS)
  })
})
