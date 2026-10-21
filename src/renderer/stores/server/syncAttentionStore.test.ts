import type { SyncAttention } from '@shared/profileSync/serverSync'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '@/stores/app/uiStore'
import { startSyncAttention, useSyncAttentionStore } from './syncAttentionStore'

const join: SyncAttention = {
  kind: 'join',
  id: 'join:d2',
  deviceId: 'd2',
  name: 'Phone',
  code: 'AAAAA-BBBBB',
  createdAt: 42,
}

beforeEach(() => {
  useSyncAttentionStore.setState({ items: [], hidden: new Set() })
})

describe('sync attention store', () => {
  it('SYA-C111 hides a denied item until it goes away', () => {
    const store = useSyncAttentionStore.getState()
    store.apply([join])
    store.hide(join.id)
    expect(useSyncAttentionStore.getState().hidden.has(join.id)).toBe(true)
    store.apply([join])
    expect(useSyncAttentionStore.getState().hidden.has(join.id)).toBe(true)
    store.apply([])
    expect(useSyncAttentionStore.getState().hidden.has(join.id)).toBe(false)
  })

  it('SYA-C112 takes the list main pushes and opens Settings › Server when main asks', () => {
    const api = vi.mocked(window.ostia.syncServer)
    let push: (items: SyncAttention[]) => void = () => {}
    let open: () => void = () => {}
    api.onAttention.mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    api.onOpen.mockImplementation((cb) => {
      open = cb
      return () => {}
    })
    const openSettings = vi.fn()
    useUIStore.setState({ openSettings })
    startSyncAttention()
    push([join])
    expect(useSyncAttentionStore.getState().items).toEqual([join])
    open()
    expect(openSettings).toHaveBeenCalledWith('server')
  })
})
