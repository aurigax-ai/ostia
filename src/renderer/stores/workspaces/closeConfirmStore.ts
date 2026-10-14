import type { QuitAnswer, RunningGroup } from '@shared/types'
import { create } from 'zustand'

export type { RunningGroup }

export type CloseConfirmKind = 'workspace' | 'pane' | 'quit' | 'move'

export interface CloseConfirmRequest {
  kind: CloseConfirmKind
  groups: RunningGroup[]
  keptShells: string[]
  resolve: (answer: QuitAnswer) => void
}

interface CloseConfirmState {
  pending: CloseConfirmRequest | null
  ask: (kind: CloseConfirmKind, groups: RunningGroup[]) => Promise<boolean>
  askQuit: (groups: RunningGroup[], keptShells: string[]) => Promise<QuitAnswer>
  answer: (confirmed: boolean) => void
  keepShells: () => void
}

export const useCloseConfirmStore = create<CloseConfirmState>((set, get) => {
  const open = (
    kind: CloseConfirmKind,
    groups: RunningGroup[],
    keptShells: string[],
  ): Promise<QuitAnswer> =>
    new Promise<QuitAnswer>((resolve) => {
      get().pending?.resolve('cancel')
      set({ pending: { kind, groups, keptShells, resolve } })
    })
  const settle = (answer: QuitAnswer): void => {
    const { pending } = get()
    if (!pending) return
    set({ pending: null })
    pending.resolve(answer)
  }
  return {
    pending: null,
    ask: (kind, groups) => open(kind, groups, []).then((answer) => answer !== 'cancel'),
    askQuit: (groups, keptShells) => open('quit', groups, keptShells),
    answer: (confirmed) => settle(confirmed ? 'quit' : 'cancel'),
    keepShells: () => {
      if (get().pending?.keptShells.length) settle('keep-shells')
    },
  }
})
