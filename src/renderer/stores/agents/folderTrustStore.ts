import { create } from 'zustand'

export type FolderTrustKind = 'resume' | 'start' | 'outside'

interface HeldFolder {
  folder: string
  kind: FolderTrustKind
}

interface FolderTrustState {
  byPane: Record<string, HeldFolder>
  hold: (paneId: string, folder: string, kind: FolderTrustKind) => void
  release: (paneId: string) => void
}

export const useFolderTrustStore = create<FolderTrustState>((set) => ({
  byPane: {},
  hold: (paneId, folder, kind) =>
    set((s) => ({ byPane: { ...s.byPane, [paneId]: { folder, kind } } })),
  release: (paneId) =>
    set((s) => {
      if (!(paneId in s.byPane)) return s
      const { [paneId]: _gone, ...byPane } = s.byPane
      return { byPane }
    }),
}))
