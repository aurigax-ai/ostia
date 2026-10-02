import type { RemoteFolder, RemoteFolderAsk } from '@shared/remoteFolders'
import { create } from 'zustand'

interface PendingAsk {
  ask: RemoteFolderAsk
  resolve: (approved: boolean) => void
}

interface RemoteFoldersState {
  folders: RemoteFolder[]
  pending: PendingAsk | null
  setFolders: (folders: RemoteFolder[]) => void
  ask: (ask: RemoteFolderAsk) => Promise<boolean>
  answer: (approved: boolean) => void
}

export const useRemoteFoldersStore = create<RemoteFoldersState>((set, get) => ({
  folders: [],
  pending: null,
  setFolders: (folders) => set({ folders }),
  ask: (ask) =>
    new Promise((resolve) => {
      get().pending?.resolve(false)
      set({ pending: { ask, resolve } })
    }),
  answer: (approved) => {
    const pending = get().pending
    set({ pending: null })
    pending?.resolve(approved)
  },
}))

export function remoteFolderOf(folders: readonly RemoteFolder[], id: string): RemoteFolder | null {
  return folders.find((folder) => folder.id === id) ?? null
}

export function wireRemoteFolders(): void {
  const api = window.pine?.remoteFiles
  if (!api) return
  const { setFolders, ask } = useRemoteFoldersStore.getState()
  api.onFolders(setFolders)
  api.onConfirm(ask)
  void api.folders().then(setFolders)
}
