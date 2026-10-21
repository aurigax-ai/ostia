import { create } from 'zustand'

interface ViewerHintState {
  pending: Record<string, string>
  request: (path: string, hint: string) => void
  take: (path: string) => string | undefined
}

export const useViewerHintStore = create<ViewerHintState>((set, get) => ({
  pending: {},
  request: (path, hint) => set((s) => ({ pending: { ...s.pending, [path]: hint } })),
  take: (path) => {
    const hint = get().pending[path]
    if (hint !== undefined) {
      set((s) => {
        const { [path]: _taken, ...rest } = s.pending
        return { pending: rest }
      })
    }
    return hint
  },
}))
