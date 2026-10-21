import { create } from 'zustand'

interface HiddenPromptsState {
  hidden: Record<string, true>
  hide: (key: string) => void
}

export const useHiddenPromptsStore = create<HiddenPromptsState>((set) => ({
  hidden: {},
  hide: (key) => set((s) => ({ hidden: { ...s.hidden, [key]: true } })),
}))

export const approvalPromptKey = (id: string): string => `approval:${id}`
export const questionPromptKey = (id: string): string => `question:${id}`
export const folderMissingPromptKey = (paneId: string, folder: string): string =>
  `folder-missing:${paneId}:${folder}`
export const conflictPromptKey = (paneId: string, holderId: string): string =>
  `conflict:${paneId}:${holderId}`
