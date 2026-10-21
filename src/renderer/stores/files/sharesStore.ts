import type {
  ShareActionResult,
  ShareAvailability,
  ShareFailure,
  ShareView,
} from '@shared/artifacts/shares'
import { create } from 'zustand'

interface SharesState {
  availability: ShareAvailability | null
  shares: ShareView[]
  error: ShareFailure | null
  loaded: boolean
  refresh: () => Promise<void>
  added: (share: ShareView) => void
  remove: (id: string) => Promise<ShareActionResult>
}

export const useSharesStore = create<SharesState>((set, get) => ({
  availability: null,
  shares: [],
  error: null,
  loaded: false,

  refresh: async () => {
    const [availability, listed] = await Promise.all([
      window.ostia.shares.status(),
      window.ostia.shares.list(),
    ])
    set({
      availability,
      shares: listed.ok ? listed.shares : [],
      error: listed.ok ? null : listed.error,
      loaded: true,
    })
  },

  added: (share) => set({ shares: [share, ...get().shares.filter((s) => s.id !== share.id)] }),

  remove: async (id) => {
    const result = await window.ostia.shares.remove(id)
    if (result.ok) set({ shares: get().shares.filter((s) => s.id !== id) })
    return result
  },
}))
