import { create } from 'zustand'

interface EditorStatusState {
  dirty: Record<string, boolean>
  setDirty: (filePath: string, dirty: boolean) => void
}

export const useEditorStatus = create<EditorStatusState>((set) => ({
  dirty: {},
  setDirty: (filePath, dirty) =>
    set((s) => {
      if ((s.dirty[filePath] ?? false) === dirty) return s
      const next = { ...s.dirty }
      if (dirty) next[filePath] = true
      else delete next[filePath]
      return { dirty: next }
    }),
}))
