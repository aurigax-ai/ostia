import { create } from 'zustand'

interface IncidentReportState {
  ref: string | null
  open: (ref: string) => void
  close: () => void
}

export const useIncidentReportStore = create<IncidentReportState>((set) => ({
  ref: null,
  open: (ref) => set({ ref }),
  close: () => set({ ref: null }),
}))
