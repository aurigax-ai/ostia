import { create } from 'zustand'

export type AppLinkPromptState =
  | { kind: 'ask'; url: string; app: string }
  | { kind: 'none'; url: string }
  | { kind: 'failed'; url: string; app: string }

interface AppLinkState {
  byPane: Record<string, AppLinkPromptState | undefined>
  show: (paneId: string, prompt: AppLinkPromptState) => void
  release: (paneId: string) => void
}

export const useAppLinkStore = create<AppLinkState>((set) => ({
  byPane: {},
  show: (paneId, prompt) => set((s) => ({ byPane: { ...s.byPane, [paneId]: prompt } })),
  release: (paneId) =>
    set((s) => {
      if (!s.byPane[paneId]) return s
      const { [paneId]: _gone, ...byPane } = s.byPane
      return { byPane }
    }),
}))
