import type { NewEntryKind } from '@shared/files/fileOps'
import { create } from 'zustand'

export type TreeEdit =
  | { kind: 'create'; entry: NewEntryKind; dir: string }
  | { kind: 'rename'; path: string }

interface TreeClipboard {
  mode: 'copy' | 'cut'
  paths: string[]
}

interface FileTreeState {
  versions: Record<string, number>
  epoch: number
  clipboard: TreeClipboard | null
  edit: TreeEdit | null
  trashing: string[] | null
  revealed: { root: string; path: string } | null
  shown: { workspaceId: string; dir: string; from: string } | null
  reveal: (root: string, path: string) => void
  show: (workspaceId: string, dir: string, from: string) => void
  reload: (dirs: string[]) => void
  reloadAll: () => void
  setClipboard: (clipboard: TreeClipboard | null) => void
  setEdit: (edit: TreeEdit | null) => void
  askTrash: (paths: string[] | null) => void
}

export const useFileTreeStore = create<FileTreeState>((set) => ({
  versions: {},
  epoch: 0,
  clipboard: null,
  edit: null,
  trashing: null,
  revealed: null,
  shown: null,
  reveal: (root, path) => set({ revealed: { root, path } }),
  show: (workspaceId, dir, from) => set({ shown: { workspaceId, dir, from }, revealed: null }),
  reload: (dirs) =>
    set((s) => {
      const versions = { ...s.versions }
      for (const dir of new Set(dirs)) versions[dir] = (versions[dir] ?? 0) + 1
      return { versions }
    }),
  reloadAll: () => set((s) => ({ epoch: s.epoch + 1 })),
  setClipboard: (clipboard) => set({ clipboard }),
  setEdit: (edit) => set({ edit }),
  askTrash: (trashing) => set({ trashing }),
}))
