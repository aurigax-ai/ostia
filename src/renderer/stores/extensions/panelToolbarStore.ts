import type {
  PanelToolbarEntry,
  PanelToolbarState,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { create } from 'zustand'

interface PanelToolbarStoreState {
  entries: PanelToolbarEntry[]
  setEntries: (entries: PanelToolbarEntry[]) => void
  selectTab: (extId: string, workspaceId: string, tab: string) => void
}

const NO_STATE: PanelToolbarState = {}

export const usePanelToolbarStore = create<PanelToolbarStoreState>((set) => ({
  entries: [],
  setEntries: (entries) => set({ entries }),
  selectTab: (extId, workspaceId, tab) =>
    set((s) => {
      const rest = s.entries.filter((e) => e.extId !== extId || e.workspaceId !== workspaceId)
      const current = s.entries.find((e) => e.extId === extId && e.workspaceId === workspaceId)
      return { entries: [...rest, { extId, workspaceId, state: { ...current?.state, tab } }] }
    }),
}))

export function toolbarStateOf(
  entries: readonly PanelToolbarEntry[],
  extId: string,
  workspaceId: string,
): PanelToolbarState {
  return entries.find((e) => e.extId === extId && e.workspaceId === workspaceId)?.state ?? NO_STATE
}
