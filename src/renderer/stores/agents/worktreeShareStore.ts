import type { WorktreeShareMap } from '@shared/agents/worktreeShareApi'
import { create } from 'zustand'

interface WorktreeShareState {
  byPane: WorktreeShareMap
  apply: (map: WorktreeShareMap) => void
}

export const useWorktreeShareStore = create<WorktreeShareState>((set) => ({
  byPane: {},
  apply: (byPane) => set({ byPane }),
}))

export function startWorktreeShare(): () => void {
  const off = window.ostia.worktreeShare.onChange((map) =>
    useWorktreeShareStore.getState().apply(map),
  )
  void window.ostia.worktreeShare
    .snapshot()
    .then((map) => useWorktreeShareStore.getState().apply(map))
  return off
}
