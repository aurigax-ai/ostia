import { create } from 'zustand'
import type { ContributedChip, ContributedChipInfo } from '../lib/promptChips'

const NO_CHIPS: readonly ContributedChip[] = []

interface PaneChipsState {
  byPane: Record<string, readonly ContributedChip[] | undefined>
  catalog: readonly ContributedChipInfo[]
  setPaneChips: (paneId: string, chips: readonly ContributedChip[]) => void
  setCatalog: (catalog: readonly ContributedChipInfo[]) => void
}

export const usePaneChipsStore = create<PaneChipsState>((set) => ({
  byPane: {},
  catalog: [],
  setPaneChips: (paneId, chips) => set((s) => ({ byPane: { ...s.byPane, [paneId]: chips } })),
  setCatalog: (catalog) => set({ catalog }),
}))

export function usePaneChips(paneId: string | null): readonly ContributedChip[] {
  return usePaneChipsStore((s) => (paneId ? s.byPane[paneId] : undefined) ?? NO_CHIPS)
}

export function useChipCatalog(): readonly ContributedChipInfo[] {
  return usePaneChipsStore((s) => s.catalog)
}
