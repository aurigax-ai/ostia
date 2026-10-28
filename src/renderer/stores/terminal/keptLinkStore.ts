import type { KeptLink } from '@shared/terminal/ptyApi'
import { create } from 'zustand'

interface KeptLinkState {
  byPane: Record<string, Exclude<KeptLink, 'up'>>
  set: (paneId: string, link: KeptLink) => void
}

export const useKeptLinkStore = create<KeptLinkState>((set) => ({
  byPane: {},
  set: (paneId, link) =>
    set((s) => {
      if (link === 'up') {
        if (!(paneId in s.byPane)) return s
        const { [paneId]: _gone, ...rest } = s.byPane
        return { byPane: rest }
      }
      return s.byPane[paneId] === link ? s : { byPane: { ...s.byPane, [paneId]: link } }
    }),
}))
