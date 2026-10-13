import { create } from 'zustand'

export type TabSleepNotice =
  | { kind: 'notAgent' | 'asleep' | 'awake' }
  | { kind: 'conflict'; tab: string }

interface TabSleepNoticeState {
  notice: TabSleepNotice | null
  show: (notice: TabSleepNotice) => void
  dismiss: () => void
}

export const useTabSleepNoticeStore = create<TabSleepNoticeState>((set) => ({
  notice: null,
  show: (notice) => set({ notice }),
  dismiss: () => set({ notice: null }),
}))
