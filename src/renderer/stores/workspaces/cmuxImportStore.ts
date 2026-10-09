import type { CmuxImportReport, CmuxSessionError } from '@shared/workspaces/cmuxSession'
import { create } from 'zustand'

export type CmuxImportOutcome =
  | { report: CmuxImportReport }
  | { error: CmuxSessionError; path?: string }

interface CmuxImportState {
  outcome: CmuxImportOutcome | null
  show: (outcome: CmuxImportOutcome) => void
  dismiss: () => void
}

export const useCmuxImportStore = create<CmuxImportState>((set) => ({
  outcome: null,
  show: (outcome) => set({ outcome }),
  dismiss: () => set({ outcome: null }),
}))
