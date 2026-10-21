import type { SyncAttention } from '@shared/profileSync/serverSync'
import { create } from 'zustand'

export interface TimedAttention {
  item: SyncAttention
  at: number
}

interface SyncAttentionState {
  items: SyncAttention[]
  seenAt: Record<string, number>
  hidden: ReadonlySet<string>
  apply: (items: SyncAttention[]) => void
  hide: (id: string) => void
}

export const useSyncAttentionStore = create<SyncAttentionState>((set) => ({
  items: [],
  seenAt: {},
  hidden: new Set(),
  apply: (items) =>
    set((state) => {
      const now = Date.now()
      const seenAt: Record<string, number> = {}
      for (const item of items) seenAt[item.id] = state.seenAt[item.id] ?? now
      const ids = new Set(items.map((item) => item.id))
      return {
        items,
        seenAt,
        hidden: new Set([...state.hidden].filter((id) => ids.has(id))),
      }
    }),
  hide: (id) => set((state) => ({ hidden: new Set([...state.hidden, id]) })),
}))

export function timedAttention(
  items: readonly SyncAttention[],
  seenAt: Readonly<Record<string, number>>,
  hidden: ReadonlySet<string>,
): TimedAttention[] {
  return items
    .filter((item) => !hidden.has(item.id))
    .map((item) => ({
      item,
      at: 'createdAt' in item ? item.createdAt : (seenAt[item.id] ?? 0),
    }))
}

export function refreshSyncAttention(): Promise<void> {
  return window.ostia.syncServer.attention().then((items) => {
    useSyncAttentionStore.getState().apply(items)
  })
}

export function startSyncAttention(): () => void {
  const off = window.ostia.syncServer.onAttention((items) =>
    useSyncAttentionStore.getState().apply(items),
  )
  void refreshSyncAttention()
  return off
}
