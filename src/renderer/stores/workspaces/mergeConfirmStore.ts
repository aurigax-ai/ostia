import { create } from 'zustand'

export interface MergeRunning {
  paneId: string
  title: string
  command: string
}

export interface MergeSummary {
  source: string
  target: string
  terminals: number
  editors: number
  browsers: number
  others: number
  running: MergeRunning[]
  chat: boolean
  sandbox: boolean
}

interface MergeConfirmRequest {
  summary: MergeSummary
  resolve: (confirmed: boolean) => void
}

interface MergeConfirmState {
  pending: MergeConfirmRequest | null
  ask: (summary: MergeSummary) => Promise<boolean>
  answer: (confirmed: boolean) => void
}

export const useMergeConfirmStore = create<MergeConfirmState>((set, get) => ({
  pending: null,
  ask: (summary) =>
    new Promise<boolean>((resolve) => {
      get().pending?.resolve(false)
      set({ pending: { summary, resolve } })
    }),
  answer: (confirmed) => {
    const { pending } = get()
    if (!pending) return
    set({ pending: null })
    pending.resolve(confirmed)
  },
}))
