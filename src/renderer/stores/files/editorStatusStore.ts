import { create } from 'zustand'

export type DiskProblem = 'changed' | 'conflict' | 'deleted'

interface EditorStatusState {
  dirty: Record<string, boolean>
  disk: Record<string, DiskProblem>
  setDirty: (filePath: string, dirty: boolean) => void
  setDisk: (filePath: string, problem: DiskProblem | null) => void
}

export const useEditorStatus = create<EditorStatusState>((set) => ({
  dirty: {},
  disk: {},
  setDisk: (filePath, problem) =>
    set((s) => {
      if ((s.disk[filePath] ?? null) === problem) return s
      const next = { ...s.disk }
      if (problem) next[filePath] = problem
      else delete next[filePath]
      return { disk: next }
    }),
  setDirty: (filePath, dirty) =>
    set((s) => {
      if ((s.dirty[filePath] ?? false) === dirty) return s
      const next = { ...s.dirty }
      if (dirty) next[filePath] = true
      else delete next[filePath]
      return { dirty: next }
    }),
}))
