import { create } from 'zustand'
import { livePaneIds } from '@/lib/panes/livePanes'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

interface HiddenPromptsState {
  hidden: Record<string, true>
  hide: (key: string) => void
  forget: (prefix: string) => void
}

export const useHiddenPromptsStore = create<HiddenPromptsState>((set) => ({
  hidden: {},
  hide: (key) => set((s) => ({ hidden: { ...s.hidden, [key]: true } })),
  forget: (prefix) =>
    set((s) => {
      const kept = Object.keys(s.hidden).filter((key) => !key.startsWith(prefix))
      return kept.length === Object.keys(s.hidden).length
        ? s
        : { hidden: Object.fromEntries(kept.map((key) => [key, true as const])) }
    }),
}))

const PANE_KEYS = ['folder-missing:', 'conflict:']

useLayoutStore.subscribe(() => {
  const { hidden } = useHiddenPromptsStore.getState()
  const keys = Object.keys(hidden).filter((key) => PANE_KEYS.some((p) => key.startsWith(p)))
  if (keys.length === 0) return
  const live = new Set(livePaneIds())
  for (const key of keys) {
    const paneId = key.split(':')[1]
    if (!live.has(paneId)) useHiddenPromptsStore.getState().forget(key)
  }
})

export const approvalPromptKey = (id: string): string => `approval:${id}`
export const questionPromptKey = (id: string): string => `question:${id}`
export const folderMissingPrefix = (paneId: string): string => `folder-missing:${paneId}:`
export const conflictPrefix = (paneId: string): string => `conflict:${paneId}:`
export const folderMissingPromptKey = (paneId: string, folder: string): string =>
  `folder-missing:${paneId}:${folder}`
export const conflictPromptKey = (paneId: string, holderId: string): string =>
  `conflict:${paneId}:${holderId}`
