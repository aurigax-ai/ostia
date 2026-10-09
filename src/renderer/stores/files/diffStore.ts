import type { DiffContent } from '@shared/extensions'
import { create } from 'zustand'

interface DiffState {
  byPane: Record<string, DiffContent>
  set: (paneId: string, content: DiffContent) => void
  retain: (paneIds: ReadonlySet<string>) => void
}

export const useDiffStore = create<DiffState>((set) => ({
  byPane: {},
  set: (paneId, content) => set((s) => ({ byPane: { ...s.byPane, [paneId]: content } })),
  retain: (paneIds) =>
    set((s) => {
      const kept = Object.entries(s.byPane).filter(([id]) => paneIds.has(id))
      return kept.length === Object.keys(s.byPane).length ? s : { byPane: Object.fromEntries(kept) }
    }),
}))
