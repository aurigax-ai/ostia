import { create } from 'zustand'

export interface WaitingFor {
  from: string
  command: string | null
}

interface OpenWaitsState {
  byPane: Record<string, WaitingFor>
  wait: (paneIds: string[], waiting: WaitingFor) => void
  end: (paneIds: string[]) => void
}

export const useOpenWaitsStore = create<OpenWaitsState>((set) => ({
  byPane: {},
  wait: (paneIds, waiting) =>
    set((s) => ({
      byPane: { ...s.byPane, ...Object.fromEntries(paneIds.map((id) => [id, waiting])) },
    })),
  end: (paneIds) =>
    set((s) => {
      if (!paneIds.some((id) => id in s.byPane)) return s
      const byPane = { ...s.byPane }
      for (const id of paneIds) delete byPane[id]
      return { byPane }
    }),
}))

export function isWaitedPane(paneId: string): boolean {
  return paneId in useOpenWaitsStore.getState().byPane
}

export function wireOpenWaits(): void {
  window.ostia?.openWaits?.onEnded?.((paneIds) => useOpenWaitsStore.getState().end(paneIds))
}
