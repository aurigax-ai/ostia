import { create } from 'zustand'
import type { UserAction } from '../settings/actions'

export type ActionConfirmAnswer = 'cancel' | 'once' | 'trust'

interface PendingAction {
  action: UserAction
  args: Record<string, unknown> | undefined
  resolve: (answer: ActionConfirmAnswer) => void
}

interface ActionConfirmState {
  pending: PendingAction | null
  ask: (
    action: UserAction,
    args: Record<string, unknown> | undefined,
  ) => Promise<ActionConfirmAnswer>
  answer: (answer: ActionConfirmAnswer) => void
}

export const useActionConfirmStore = create<ActionConfirmState>((set, get) => ({
  pending: null,
  ask: (action, args) =>
    new Promise((resolve) => {
      get().pending?.resolve('cancel')
      set({ pending: { action, args, resolve } })
    }),
  answer: (answer) => {
    const pending = get().pending
    set({ pending: null })
    pending?.resolve(answer)
  },
}))
