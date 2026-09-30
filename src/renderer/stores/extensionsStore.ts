import type { ExtensionInfo, ExtensionSidebarItem, PaneChip } from '@shared/extensions'
import { create } from 'zustand'
import { useSettingsStore } from './settingsStore'

export interface PanelNavigation {
  path: string
  seq: number
}

interface ExtensionsState {
  list: ExtensionInfo[]
  sidebar: ExtensionSidebarItem[]
  chips: PaneChip[]
  panelNav: Record<string, PanelNavigation>
  reviewing: string | null
  dismissed: string[]
  setList: (list: ExtensionInfo[]) => void
  setSidebar: (items: ExtensionSidebarItem[]) => void
  setChips: (chips: PaneChip[]) => void
  navigatePanel: (paneId: string, path: string) => void
  load: () => Promise<void>
  setEnabled: (extId: string, enabled: boolean) => Promise<void>
  setSetting: (extId: string, key: string, value: unknown) => Promise<string | null>
  approve: (extId: string) => Promise<void>
  review: (extId: string | null) => void
  dismiss: (extId: string) => void
}

let navSeq = 0

export const useExtensionsStore = create<ExtensionsState>((set) => ({
  list: [],
  sidebar: [],
  chips: [],
  panelNav: {},
  reviewing: null,
  dismissed: [],

  setList: (list) => set({ list }),
  setSidebar: (sidebar) => set({ sidebar }),
  setChips: (chips) => set({ chips }),

  navigatePanel: (paneId, path) =>
    set((s) => ({ panelNav: { ...s.panelNav, [paneId]: { path, seq: ++navSeq } } })),

  load: async () => {
    const [list, sidebar, chips] = await Promise.all([
      window.pine.extensions.list(),
      window.pine.extensions.sidebarItems(),
      window.pine.extensions.paneChips(),
    ])
    set({ list, sidebar, chips })
  },

  setEnabled: async (extId, enabled) => {
    set({ list: await window.pine.extensions.setEnabled(extId, enabled) })
  },

  setSetting: async (extId, key, value) => {
    const res = await window.pine.extensions.setSetting(extId, key, value)
    if (!res.ok) return res.error
    set({ list: res.list })
    useSettingsStore.getState().setExtensionSettings(extId, res.stored)
    return null
  },

  approve: async (extId) => {
    const list = await window.pine.extensions.approve(extId)
    set((s) => ({ list, reviewing: s.reviewing === extId ? null : s.reviewing }))
  },

  review: (reviewing) => set({ reviewing }),

  dismiss: (extId) =>
    set((s) => ({
      dismissed: s.dismissed.includes(extId) ? s.dismissed : [...s.dismissed, extId],
      reviewing: s.reviewing === extId ? null : s.reviewing,
    })),
}))

export function pendingApproval(
  state: Pick<ExtensionsState, 'list' | 'dismissed'>,
): ExtensionInfo | null {
  return (
    state.list.find((e) => e.status === 'pending-approval' && !state.dismissed.includes(e.id)) ??
    null
  )
}
