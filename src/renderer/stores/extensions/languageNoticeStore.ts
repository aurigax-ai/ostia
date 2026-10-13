import { create } from 'zustand'

interface LanguageNoticeState {
  owners: Record<string, string>
  claim: (extId: string, paneId: string) => boolean
  release: (paneId: string) => void
}

export const useLanguageNoticeStore = create<LanguageNoticeState>((set, get) => ({
  owners: {},

  claim: (extId, paneId) => {
    const owner = get().owners[extId]
    if (owner !== undefined) return owner === paneId
    set((s) => ({ owners: { ...s.owners, [extId]: paneId } }))
    return true
  },

  release: (paneId) =>
    set((s) => ({
      owners: Object.fromEntries(Object.entries(s.owners).filter(([, owner]) => owner !== paneId)),
    })),
}))
