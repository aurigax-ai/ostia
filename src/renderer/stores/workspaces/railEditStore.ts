import { create } from 'zustand'

export type RailEdit =
  | { kind: 'workspace'; id: string; field: 'name' | 'description' }
  | { kind: 'group'; id: string }

interface RailEditState {
  pending: RailEdit | null
  begin: (edit: RailEdit) => void
  clear: () => void
}

export const useRailEditStore = create<RailEditState>((set) => ({
  pending: null,
  begin: (pending) => set({ pending }),
  clear: () => set({ pending: null }),
}))
