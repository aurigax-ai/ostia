import { create } from 'zustand'

export interface PdfFindRequest {
  page: number
  query: string
}

interface PdfFindState {
  pending: Record<string, PdfFindRequest>
  request: (path: string, find: PdfFindRequest) => void
  take: (path: string) => PdfFindRequest | undefined
}

export const usePdfFindStore = create<PdfFindState>((set, get) => ({
  pending: {},
  request: (path, find) => set((s) => ({ pending: { ...s.pending, [path]: find } })),
  take: (path) => {
    const find = get().pending[path]
    if (find) {
      set((s) => {
        const { [path]: _taken, ...rest } = s.pending
        return { pending: rest }
      })
    }
    return find
  },
}))
