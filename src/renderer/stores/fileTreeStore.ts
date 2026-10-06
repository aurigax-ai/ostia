import type { NewEntryKind } from '@shared/fileOps'
import { create } from 'zustand'

export type TreeEdit =
  | { kind: 'create'; entry: NewEntryKind; dir: string }
  | { kind: 'rename'; path: string }

export interface TreeClipboard {
  mode: 'copy' | 'cut'
  paths: string[]
}

interface FileTreeState {
  versions: Record<string, number>
  clipboard: TreeClipboard | null
  edit: TreeEdit | null
  trashing: string[] | null
  reload: (dirs: string[]) => void
  setClipboard: (clipboard: TreeClipboard | null) => void
  setEdit: (edit: TreeEdit | null) => void
  askTrash: (paths: string[] | null) => void
}

export const useFileTreeStore = create<FileTreeState>((set) => ({
  versions: {},
  clipboard: null,
  edit: null,
  trashing: null,
  reload: (dirs) =>
    set((s) => {
      const versions = { ...s.versions }
      for (const dir of new Set(dirs)) versions[dir] = (versions[dir] ?? 0) + 1
      return { versions }
    }),
  setClipboard: (clipboard) => set({ clipboard }),
  setEdit: (edit) => set({ edit }),
  askTrash: (trashing) => set({ trashing }),
}))
