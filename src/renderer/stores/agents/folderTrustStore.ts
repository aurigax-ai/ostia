import { create } from 'zustand'

interface FolderTrustState {
  byPane: Record<string, string>
  hold: (paneId: string, folder: string) => void
  release: (paneId: string) => void
}

export const useFolderTrustStore = create<FolderTrustState>((set) => ({
  byPane: {},
  hold: (paneId, folder) => set((s) => ({ byPane: { ...s.byPane, [paneId]: folder } })),
  release: (paneId) =>
    set((s) => {
      if (!(paneId in s.byPane)) return s
      const { [paneId]: _gone, ...byPane } = s.byPane
      return { byPane }
    }),
}))
