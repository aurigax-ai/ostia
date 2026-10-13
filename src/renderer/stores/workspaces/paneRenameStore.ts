import { findPane } from '@/layout/tree'
import { create } from 'zustand'
import { useLayoutStore } from './layoutStore'
import { useWorkspacesStore } from './workspacesStore'

interface PaneRenameState {
  paneId: string | null
  begin: (paneId: string) => void
  end: () => void
}

export const usePaneRenameStore = create<PaneRenameState>((set) => ({
  paneId: null,
  begin: (paneId) => set({ paneId }),
  end: () => set({ paneId: null }),
}))

function stop(): void {
  if (usePaneRenameStore.getState().paneId !== null) usePaneRenameStore.getState().end()
}

export function startPaneRenameSync(): () => void {
  const offWorkspaces = useWorkspacesStore.subscribe((s, prev) => {
    if (s.activeWorkspaceId !== prev.activeWorkspaceId) stop()
  })
  const offLayout = useLayoutStore.subscribe((s) => {
    const { paneId } = usePaneRenameStore.getState()
    if (paneId === null) return
    if (!Object.values(s.byWorkspace).some((layout) => findPane(layout.root, paneId))) stop()
  })
  return () => {
    offWorkspaces()
    offLayout()
  }
}
