import type { HistoryMatch, HistorySearchOptions } from '@shared/terminal/scrollbackHistory'
import { create } from 'zustand'

export interface HistoryFind {
  query: string
  options: HistorySearchOptions
  matches: HistoryMatch[]
  index: number
}

export type HistoryTarget =
  | { kind: 'aboveLive'; liveLines: number }
  | { kind: 'line'; line: number }
  | { kind: 'match'; find: HistoryFind }

interface HistoryViewState {
  open: Record<string, HistoryTarget | undefined>
  show: (paneId: string, target: HistoryTarget) => void
  close: (paneId: string) => void
}

export const useHistoryViewStore = create<HistoryViewState>((set) => ({
  open: {},
  show: (paneId, target) => set((s) => ({ open: { ...s.open, [paneId]: target } })),
  close: (paneId) =>
    set((s) => {
      if (!s.open[paneId]) return s
      const { [paneId]: _closed, ...open } = s.open
      return { open }
    }),
}))
