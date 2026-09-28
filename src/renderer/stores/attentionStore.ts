import { create } from 'zustand'
import {
  type AttentionEvent,
  EMPTY_ATTENTION,
  type PaneAttention,
  reduceAttention,
} from '../lib/attention'

interface AttentionStoreState {
  byPane: Record<string, PaneAttention>
  dispatch: (paneId: string, event: AttentionEvent) => void
  dropPane: (paneId: string) => void
  markAllRead: () => void
}

export const useAttentionStore = create<AttentionStoreState>((set, get) => ({
  byPane: {},

  dispatch: (paneId, event) => {
    const prev = get().byPane[paneId] ?? EMPTY_ATTENTION
    const next = reduceAttention(prev, event)
    if (next === prev) return
    set((s) => ({ byPane: { ...s.byPane, [paneId]: next } }))
  },

  dropPane: (paneId) => {
    if (!(paneId in get().byPane)) return
    set((s) => {
      const { [paneId]: _gone, ...rest } = s.byPane
      return { byPane: rest }
    })
  },

  markAllRead: () => {
    const at = Date.now()
    set((s) => {
      const byPane: Record<string, PaneAttention> = {}
      for (const [id, a] of Object.entries(s.byPane)) {
        byPane[id] = reduceAttention(a, { type: 'view', at })
      }
      return { byPane }
    })
  },
}))
