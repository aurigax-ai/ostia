import { create } from 'zustand'

export type LiveSelectionSource =
  | { kind: 'editor'; file: string; startLine: number; endLine: number }
  | { kind: 'terminal' }

export interface LiveSelection {
  paneId: string
  source: LiveSelectionSource
  text: string
}

interface LiveSelectionState {
  byWorkspace: Record<string, LiveSelection>
  report: (workspaceId: string, paneId: string, source: LiveSelectionSource, text: string) => void
  clear: (paneId: string) => void
}

export const useLiveSelectionStore = create<LiveSelectionState>((set, get) => ({
  byWorkspace: {},
  report: (workspaceId, paneId, source, text) => {
    if (!text.trim()) {
      get().clear(paneId)
      return
    }
    set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspaceId]: { paneId, source, text } } }))
  },
  clear: (paneId) =>
    set((s) => {
      const owner = Object.keys(s.byWorkspace).find((id) => s.byWorkspace[id].paneId === paneId)
      if (!owner) return s
      const { [owner]: _gone, ...byWorkspace } = s.byWorkspace
      return { byWorkspace }
    }),
}))
