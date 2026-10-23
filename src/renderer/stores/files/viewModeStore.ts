import { create } from 'zustand'

export interface ViewMode {
  icon: 'viewer' | 'run' | 'source'
  label: string
  act: () => void
}

interface ViewModeState {
  byPane: Record<string, ViewMode>
  publish: (paneId: string, mode: ViewMode) => () => void
}

export const useViewModeStore = create<ViewModeState>((set, get) => ({
  byPane: {},
  publish: (paneId, mode) => {
    set((s) => ({ byPane: { ...s.byPane, [paneId]: mode } }))
    return () => {
      if (get().byPane[paneId] !== mode) return
      set((s) => {
        const { [paneId]: _gone, ...rest } = s.byPane
        return { byPane: rest }
      })
    }
  },
}))
