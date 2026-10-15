import type {
  SnippetEntry,
  SnippetListing,
} from '@aurigax-ai/ostia-extension-sdk/contract/snippets'
import { create } from 'zustand'

const EMPTY_LISTING: SnippetListing = { snippets: [], problems: [] }

interface SnippetsState {
  pickerOpen: boolean
  listing: SnippetListing
  targetPaneId: string | null
  chosen: SnippetEntry | null
  saveCommand: string | null
  showPicker: (listing: SnippetListing, targetPaneId: string | null) => void
  closePicker: () => void
  choose: (snippet: SnippetEntry | null) => void
  startSave: (command: string | null) => void
}

export const useSnippetsStore = create<SnippetsState>((set) => ({
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
