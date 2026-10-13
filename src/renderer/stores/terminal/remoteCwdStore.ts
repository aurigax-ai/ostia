import type { RemoteCwd } from '@shared/remoteFolders'
import { create } from 'zustand'

interface RemoteCwdState {
  byPane: Record<string, RemoteCwd | undefined>
  report: (paneId: string, remote: RemoteCwd | null) => void
}

export const useRemoteCwdStore = create<RemoteCwdState>((set) => ({
  byPane: {},
  report: (paneId, remote) =>
    set((s) => {
      const current = s.byPane[paneId]
      if (!remote) {
        if (!current) return s
        const { [paneId]: _gone, ...byPane } = s.byPane
        return { byPane }
      }
      if (current?.host === remote.host && current.cwd === remote.cwd) return s
      return { byPane: { ...s.byPane, [paneId]: remote } }
    }),
}))
