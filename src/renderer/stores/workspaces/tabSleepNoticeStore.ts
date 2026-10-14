import { create } from 'zustand'

type TabSleepNotice =
  | { kind: 'notAgent' | 'asleep' | 'awake' }
  | { kind: 'conflict'; tab: string }
  | { kind: 'forkFolderMissing'; agent: string; path: string }

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
