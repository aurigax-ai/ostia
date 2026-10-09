import { create } from 'zustand'

export type GitPage = 'changes' | 'graph' | 'blame'

export interface GitNavigation {
  page: GitPage
  file?: string
  seq: number
}

interface GitViewState {
  nav: Record<string, GitNavigation>
  navigate: (paneId: string, page: GitPage, file?: string) => void
  forget: (paneId: string) => void
}

let navSeq = 0

export const useGitViewStore = create<GitViewState>((set) => ({
  nav: {},
  navigate: (paneId, page, file) =>
    set((s) => ({
      nav: { ...s.nav, [paneId]: { page, ...(file ? { file } : {}), seq: ++navSeq } },
    })),
  forget: (paneId) =>
    set((s) => {
      if (!(paneId in s.nav)) return s
      const { [paneId]: _gone, ...nav } = s.nav
      return { nav }
    }),
}))
