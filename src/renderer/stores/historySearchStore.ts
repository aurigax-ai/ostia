import { create } from 'zustand'

interface HistorySearchState {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useHistorySearchStore = create<HistorySearchState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))
