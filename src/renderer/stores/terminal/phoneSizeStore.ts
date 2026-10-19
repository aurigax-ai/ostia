import { create } from 'zustand'

interface PhoneSized {
  cols: number
  useDesktop: () => void
}

interface PhoneSizeState {
  byPane: Record<string, PhoneSized>
  hold: (paneId: string, sized: PhoneSized) => void
  release: (paneId: string) => void
}

export const usePhoneSizeStore = create<PhoneSizeState>((set) => ({
  byPane: {},
  hold: (paneId, sized) => set((s) => ({ byPane: { ...s.byPane, [paneId]: sized } })),
  release: (paneId) =>
    set((s) => {
      if (!(paneId in s.byPane)) return s
      const { [paneId]: _gone, ...rest } = s.byPane
      return { byPane: rest }
    }),
}))
