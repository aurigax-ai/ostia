import { describe, expect, it, vi } from 'vitest'
import type { ServerSyncStatus, SyncAttention } from '../../../shared/profileSync/serverSync'
import type { ServerDevice } from '../../../shared/server/serverApi'
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

const device = (over: Partial<ServerDevice>): ServerDevice => ({
  id: 'd2',
  name: 'Phone',
  current: false,
  lastSeen: 0,
  createdAt: 100,
  isNew: false,
  ...over,
})

function setup() {
  const state = {
    signedIn: true,
    status: STATUS,
    devices: { ok: true, devices: [] as ServerDevice[] } as
      | { ok: true; devices: ServerDevice[] }
      | { ok: false; error: 'unreachable' },
    approvals: { ok: true, approvals: [] as never[] } as
      | { ok: true; approvals: never[] }
      | { ok: false; error: 'unreachable' },
  }
  const publish = vi.fn<(items: SyncAttention[]) => void>()
  const notify = vi.fn<(item: SyncAttention) => void>()
  const watch = createSyncAttention({
    signedIn: () => state.signedIn,
    syncStatus: async () => state.status,
    devices: async () => state.devices,
    approvals: async () => state.approvals,
    publish,
    notify,
  })
  return { state, publish, notify, watch }
}

describe('sync attention', () => {
  it('SYA-C100 lists join requests, new devices, approvals and changed devices', async () => {
    const { state, watch } = setup()
    state.status = {
      ...STATUS,
      joins: [{ deviceId: 'd3', name: 'Tablet', code: 'AAAAA-BBBBB', createdAt: 7 }],
      changedDevices: ['Laptop'],
    }
    state.devices = {
      ok: true,
      devices: [device({ isNew: true }), device({ id: 'me', current: true, isNew: true })],
    }
    state.approvals = {
      ok: true,
      approvals: [
        { id: 'a1', deviceName: 'Watch', deviceCreatedAt: 1, createdAt: 9, expiresAt: 99 },
      ] as never[],
    }
    const items = await watch.scan()
    expect(items.map((i) => i.id)).toEqual([
      'join:d3',
      'changed:Laptop',
      'new-device:d2',
      'approval:a1',
    ])
    expect(items.at(-1)).toMatchObject({ deviceCreatedAt: 1, createdAt: 9 })
  })

  it('SYA-C101 notifies once per item and again only after it went away', async () => {
    const { state, notify, watch } = setup()
    state.devices = { ok: true, devices: [device({ isNew: true })] }
    await watch.scan()
    await watch.scan()
    expect(notify).toHaveBeenCalledTimes(1)
    state.devices = { ok: true, devices: [device({ isNew: false })] }
    await watch.scan()
    state.devices = { ok: true, devices: [device({ isNew: true })] }
    await watch.scan()
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('SYA-C102 publishes only when the list changes', async () => {
    const { state, publish, watch } = setup()
    await watch.scan()
    expect(publish).not.toHaveBeenCalled()
    state.devices = { ok: true, devices: [device({ isNew: true })] }
    await watch.scan()
    await watch.scan()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('SYA-C103 keeps the list and stays quiet while the server is unreachable', async () => {
    const { state, publish, notify, watch } = setup()
    state.devices = { ok: true, devices: [device({ isNew: true })] }
    await watch.scan()
    state.devices = { ok: false, error: 'unreachable' }
    expect(await watch.scan()).toHaveLength(1)
    state.devices = { ok: true, devices: [device({ isNew: true })] }
    await watch.scan()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('SYA-C104 empties the list when signed out', async () => {
    const { state, publish, watch } = setup()
    state.devices = { ok: true, devices: [device({ isNew: true })] }
    await watch.scan()
    state.signedIn = false
    expect(await watch.scan()).toEqual([])
    expect(publish).toHaveBeenLastCalledWith([])
  })
})
