import type {
  PanelToolbarEntry,
  PanelToolbarState,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { create } from 'zustand'

interface Pending {
  tab: string
  base: string
}

interface PanelToolbarStoreState {
  entries: PanelToolbarEntry[]
  pending: Record<string, Pending>
  surfaceChosen: Record<string, boolean>
  setEntries: (entries: PanelToolbarEntry[]) => void
  selectTab: (extId: string, workspaceId: string, tab: string) => void
  chooseSurface: (extId: string, workspaceId: string, on: boolean) => void
}

export const surfaceKey = (extId: string, workspaceId: string): string =>
  `${extId}\u0000${workspaceId}`

const NO_STATE: PanelToolbarState = {}

const keyOf = (extId: string, workspaceId: string): string => `${extId}\u0000${workspaceId}`

const isEntry =
  (extId: string, workspaceId: string) =>
  (entry: PanelToolbarEntry): boolean =>
    entry.extId === extId && entry.workspaceId === workspaceId

export function toolbarStateOf(
  entries: readonly PanelToolbarEntry[],
  extId: string,
  workspaceId: string,
): PanelToolbarState {
  return entries.find(isEntry(extId, workspaceId))?.state ?? NO_STATE
}

function withPendingTabs(
  incoming: readonly PanelToolbarEntry[],
  pending: Record<string, Pending>,
): Pick<PanelToolbarStoreState, 'entries' | 'pending'> {
  const entries = [...incoming]
  const kept: Record<string, Pending> = {}
  for (const [key, wait] of Object.entries(pending)) {
    const [extId = '', workspaceId = ''] = key.split('\u0000')
    const state = toolbarStateOf(incoming, extId, workspaceId)
    if (state.tab === wait.tab || JSON.stringify(state) !== wait.base) continue
    kept[key] = wait
    const shown = { extId, workspaceId, state: { ...state, tab: wait.tab } }
    const at = entries.findIndex(isEntry(extId, workspaceId))
    if (at === -1) entries.push(shown)
    else entries[at] = shown
  }
  return { entries, pending: kept }
}

export const usePanelToolbarStore = create<PanelToolbarStoreState>((set) => ({
  chooseSurface: (extId, workspaceId, on) =>
    set((s) => ({ surfaceChosen: { ...s.surfaceChosen, [surfaceKey(extId, workspaceId)]: on } })),
  entries: [],
  pending: {},
  surfaceChosen: {},
  setEntries: (incoming) => set((s) => withPendingTabs(incoming, s.pending)),
  selectTab: (extId, workspaceId, tab) =>
    set((s) => {
      const current = toolbarStateOf(s.entries, extId, workspaceId)
      const rest = s.entries.filter((e) => !isEntry(extId, workspaceId)(e))
      return {
        entries: [...rest, { extId, workspaceId, state: { ...current, tab } }],
        pending: {
          ...s.pending,
          [keyOf(extId, workspaceId)]: { tab, base: JSON.stringify(current) },
        },
      }
    }),
}))
