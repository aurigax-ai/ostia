import type { WorkflowEntry, WorkflowListing } from '@shared/workflows'
import { create } from 'zustand'

export const EMPTY_LISTING: WorkflowListing = { workflows: [], problems: [] }

interface WorkflowsState {
  pickerOpen: boolean
  listing: WorkflowListing
  targetPaneId: string | null
  chosen: WorkflowEntry | null
  saveCommand: string | null
  showPicker: (listing: WorkflowListing, targetPaneId: string | null) => void
  closePicker: () => void
  choose: (workflow: WorkflowEntry | null) => void
  startSave: (command: string | null) => void
}

export const useWorkflowsStore = create<WorkflowsState>((set) => ({
  pickerOpen: false,
  listing: EMPTY_LISTING,
  targetPaneId: null,
  chosen: null,
  saveCommand: null,
  showPicker: (listing, targetPaneId) =>
    set({ pickerOpen: true, listing, targetPaneId, chosen: null }),
  closePicker: () => set({ pickerOpen: false, chosen: null }),
  choose: (chosen) => set({ chosen }),
  startSave: (saveCommand) => set({ saveCommand }),
}))
