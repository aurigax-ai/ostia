import type { SyncAttention } from '@shared/profileSync/serverSync'
import { create } from 'zustand'
import { useUIStore } from '@/stores/app/uiStore'

interface SyncAttentionState {
  items: SyncAttention[]
  hidden: ReadonlySet<string>
  apply: (items: SyncAttention[]) => void
  hide: (id: string) => void
}

export const useSyncAttentionStore = create<SyncAttentionState>((set) => ({
  items: [],
  hidden: new Set(),
  apply: (items) =>
    set((state) => {
      const ids = new Set(items.map((item) => item.id))
      return { items, hidden: new Set([...state.hidden].filter((id) => ids.has(id))) }
    }),
  hide: (id) => set((state) => ({ hidden: new Set([...state.hidden, id]) })),
}))

export function refreshSyncAttention(): Promise<void> {
  return window.ostia.syncServer.attention().then((items) => {
    useSyncAttentionStore.getState().apply(items)
  })
}

export function startSyncAttention(): () => void {
  const off = window.ostia.syncServer.onAttention((items) =>
    useSyncAttentionStore.getState().apply(items),
  )
  const offOpen = window.ostia.syncServer.onOpen((page) => useUIStore.getState().openSettings(page))
  void refreshSyncAttention()
  return () => {
    off()
    offOpen()
  }
}
