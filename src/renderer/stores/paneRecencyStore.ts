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
    for (const [sessionId, layout] of Object.entries(useLayoutStore.getState().bySession)) {
      if (seen[sessionId] === layout.activePaneId) continue
      seen[sessionId] = layout.activePaneId
      touch(layout.activePaneId)
    }
  }
  record()
  return useLayoutStore.subscribe(record)
}
