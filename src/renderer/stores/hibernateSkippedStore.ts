import { create } from 'zustand'
import type { HibernateReport, SkippedAgents } from '../lib/hibernationScheduler'

interface HibernateSkippedState {
  skipped: SkippedAgents | null
  show: (report: HibernateReport) => void
  dismiss: () => void
}

export const useHibernateSkippedStore = create<HibernateSkippedState>((set) => ({
  skipped: null,
  show: (report) => {
    if (Object.keys(report.skipped).length > 0) set({ skipped: report.skipped })
  },
  dismiss: () => set({ skipped: null }),
}))
