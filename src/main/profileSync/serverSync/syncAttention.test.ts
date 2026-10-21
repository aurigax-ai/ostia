import { describe, expect, it, vi } from 'vitest'
import type { ServerSyncStatus, SyncAttention } from '../../../shared/profileSync/serverSync'
import { createSyncAttention } from './syncAttention'

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

function setup() {
  const state = {
    signedIn: true,
    status: STATUS,
    approvals: { ok: true, approvals: [] } as Approvals,
  }
  const publish = vi.fn<(items: SyncAttention[]) => void>()
  const notify = vi.fn<(item: SyncAttention) => void>()
  const watch = createSyncAttention({
    signedIn: () => state.signedIn,
    syncStatus: async () => state.status,
    approvals: async () => state.approvals,
    publish,
    notify,
  })
  return { state, publish, notify, watch }
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
})
