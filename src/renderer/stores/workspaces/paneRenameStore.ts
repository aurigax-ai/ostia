import { create } from 'zustand'

interface PaneRenameState {
  paneId: string | null
  begin: (paneId: string) => void
  end: () => void
}

export const usePaneRenameStore = create<PaneRenameState>((set) => ({
  paneId: null,
  begin: (paneId) => set({ paneId }),
  end: () => set({ paneId: null }),
}))
