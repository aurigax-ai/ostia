import type { RunningGroup } from '@shared/types'
import { create } from 'zustand'

export type { RunningGroup }

export type CloseConfirmKind = 'workspace' | 'pane' | 'quit' | 'move'

export interface CloseConfirmRequest {
  kind: CloseConfirmKind
  groups: RunningGroup[]
  resolve: (confirmed: boolean) => void
}

interface CloseConfirmState {
  pending: CloseConfirmRequest | null
  ask: (kind: CloseConfirmKind, groups: RunningGroup[]) => Promise<boolean>
  answer: (confirmed: boolean) => void
}

export const useCloseConfirmStore = create<CloseConfirmState>((set, get) => ({
  pending: null,
  ask: (kind, groups) =>
    new Promise<boolean>((resolve) => {
      get().pending?.resolve(false)
      set({ pending: { kind, groups, resolve } })
    }),
  answer: (confirmed) => {
    const { pending } = get()
    if (!pending) return
    set({ pending: null })
    pending.resolve(confirmed)
  },
}))
