import { create } from 'zustand'

export interface RevealPosition {
  line: number
  column: number
}

interface EditorRevealState {
  pending: Record<string, RevealPosition>
  request: (path: string, position: RevealPosition) => void
  take: (path: string) => RevealPosition | undefined
}

export const useEditorRevealStore = create<EditorRevealState>((set, get) => ({
  pending: {},
  request: (path, position) => set((s) => ({ pending: { ...s.pending, [path]: position } })),
  take: (path) => {
    const position = get().pending[path]
    if (position) {
      set((s) => {
        const { [path]: _taken, ...rest } = s.pending
        return { pending: rest }
      })
    }
    return position
  },
}))
