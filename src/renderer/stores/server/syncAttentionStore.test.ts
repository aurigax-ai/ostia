import type { SyncAttention } from '@shared/profileSync/serverSync'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { timedAttention, useSyncAttentionStore } from './syncAttentionStore'

const changed: SyncAttention = { kind: 'changed', id: 'changed:Laptop', names: ['Laptop'] }
const join: SyncAttention = {
  kind: 'join',
  id: 'join:d2',
  deviceId: 'd2',
  name: 'Phone',
  code: 'AAAAA-BBBBB',
  createdAt: 42,
}

beforeEach(() => {
  useSyncAttentionStore.setState({ items: [], seenAt: {}, hidden: new Set() })
})

describe('sync attention store', () => {
  it('SYA-C110 keeps the first time an item without a date was seen', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000)
    const store = useSyncAttentionStore.getState()
    store.apply([changed])
    store.apply([changed])
    const { items, seenAt, hidden } = useSyncAttentionStore.getState()
    expect(timedAttention(items, seenAt, hidden)).toEqual([{ item: changed, at: 1000 }])
    vi.restoreAllMocks()
  })

  it('SYA-C111 uses the device date and hides a denied item until it goes away', () => {
    const store = useSyncAttentionStore.getState()
    store.apply([join])
    store.hide(join.id)
    let { items, seenAt, hidden } = useSyncAttentionStore.getState()
    expect(timedAttention(items, seenAt, hidden)).toEqual([])
    store.apply([])
    store.apply([join])
    ;({ items, seenAt, hidden } = useSyncAttentionStore.getState())
    expect(timedAttention(items, seenAt, hidden)).toEqual([{ item: join, at: 42 }])
  })
})
