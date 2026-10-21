import { create } from 'zustand'
import { findPane, findSplitTab } from '@/lib/layout/tree'
import { useLayoutStore } from './layoutStore'
import { useWorkspacesStore } from './workspacesStore'

interface PaneRenameState {
  paneId: string | null
  splitTabId: string | null
  begin: (paneId: string) => void
  beginSplitTab: (splitTabId: string) => void
  end: () => void
}

export const usePaneRenameStore = create<PaneRenameState>((set) => ({
  paneId: null,
  splitTabId: null,
  begin: (paneId) => set({ paneId, splitTabId: null }),
  beginSplitTab: (splitTabId) => set({ paneId: null, splitTabId }),
  end: () => set({ paneId: null, splitTabId: null }),
}))

function stop(): void {
  const { paneId, splitTabId } = usePaneRenameStore.getState()
  if (paneId !== null || splitTabId !== null) usePaneRenameStore.getState().end()
}

export function startPaneRenameSync(): () => void {
  const offWorkspaces = useWorkspacesStore.subscribe((s, prev) => {
    if (s.activeWorkspaceId !== prev.activeWorkspaceId) stop()
  })
  const offLayout = useLayoutStore.subscribe((s) => {
    const { paneId, splitTabId } = usePaneRenameStore.getState()
    const layouts = Object.values(s.byWorkspace)
    if (paneId !== null && !layouts.some((layout) => findPane(layout.root, paneId))) stop()
    if (splitTabId !== null && !layouts.some((l) => findSplitTab(l.root, splitTabId))) stop()
  })
  return () => {
    offWorkspaces()
    offLayout()
  }
}
