import { create } from 'zustand'

interface AssistComposerState {
  paneId: string | null
  open: (paneId: string) => void
  close: () => void
}

export const useAssistComposerStore = create<AssistComposerState>((set) => ({
  paneId: null,
  open: (paneId) => set({ paneId }),
  close: () => set({ paneId: null }),
}))
