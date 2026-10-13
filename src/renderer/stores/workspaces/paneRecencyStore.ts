import { create } from 'zustand'
import { useLayoutStore } from './layoutStore'

interface PaneRecencyState {
  touchedAt: Record<string, number>
  touch: (paneId: string, at?: number) => void
}

export const usePaneRecencyStore = create<PaneRecencyState>((set) => ({
  touchedAt: {},
  touch: (paneId, at = Date.now()) => set((s) => ({ touchedAt: { ...s.touchedAt, [paneId]: at } })),
}))

export function startPaneRecencySync(): () => void {
  const seen: Record<string, string> = {}
  const record = (): void => {
    const { touch } = usePaneRecencyStore.getState()
    for (const [workspaceId, layout] of Object.entries(useLayoutStore.getState().byWorkspace)) {
      if (seen[workspaceId] === layout.activePaneId) continue
      seen[workspaceId] = layout.activePaneId
      touch(layout.activePaneId)
    }
  }
  record()
  return useLayoutStore.subscribe(record)
}
