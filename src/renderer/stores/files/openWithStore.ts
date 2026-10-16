import { create } from 'zustand'

interface OpenWithState {
  paneId: string | null
  open: (paneId: string) => void
  close: () => void
}

export const useOpenWithStore = create<OpenWithState>((set) => ({
  paneId: null,
  open: (paneId) => set({ paneId }),
  close: () => set({ paneId: null }),
}))
