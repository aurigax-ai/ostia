import type { WindowSummary } from '@shared/types'
import { create } from 'zustand'

interface WindowsState {
  windowId: string | null
  detached: boolean
  list: WindowSummary[]
  setInfo: (windowId: string, detached: boolean) => void
  setList: (list: WindowSummary[]) => void
}

export const useWindowsStore = create<WindowsState>((set) => ({
  windowId: null,
  detached: false,
  list: [],
  setInfo: (windowId, detached) => set({ windowId, detached }),
  setList: (list) => set({ list }),
}))
