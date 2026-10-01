import type {
  ExtensionInfo,
  ExtensionSidebarItem,
  PaneChip,
  WorkspaceChip,
} from '@shared/extensions'
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
  workspaceChips: WorkspaceChip[]
  panelNav: Record<string, PanelNavigation>
  reviewing: string | null
  dismissed: string[]
  setList: (list: ExtensionInfo[]) => void
  setSidebar: (items: ExtensionSidebarItem[]) => void
  setChips: (chips: PaneChip[]) => void
  setWorkspaceChips: (chips: WorkspaceChip[]) => void
  navigatePanel: (paneId: string, path: string) => void
  load: () => Promise<void>
  setEnabled: (extId: string, enabled: boolean) => Promise<void>
  setSetting: (extId: string, key: string, value: unknown) => Promise<string | null>
  setSecret: (extId: string, key: string, value: string | null) => Promise<string | null>
  approve: (extId: string) => Promise<void>
  review: (extId: string | null) => void
  dismiss: (extId: string) => void
}

let navSeq = 0

export const useExtensionsStore = create<ExtensionsState>((set) => ({
  list: [],
  sidebar: [],
  chips: [],
  workspaceChips: [],
  panelNav: {},
  reviewing: null,
  dismissed: [],

  setList: (list) => set({ list }),
  setSidebar: (sidebar) => set({ sidebar }),
  setChips: (chips) => set({ chips }),
  setWorkspaceChips: (workspaceChips) => set({ workspaceChips }),

  navigatePanel: (paneId, path) =>
    set((s) => ({ panelNav: { ...s.panelNav, [paneId]: { path, seq: ++navSeq } } })),

  load: async () => {
    const [list, sidebar, chips, workspaceChips] = await Promise.all([
      window.pine.extensions.list(),
      window.pine.extensions.sidebarItems(),
      window.pine.extensions.paneChips(),
      window.pine.extensions.workspaceChips(),
    ])
    set({ list, sidebar, chips, workspaceChips })
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

  setSecret: async (extId, key, value) => {
    const res = await window.pine.extensions.setSecret(extId, key, value)
    if (!res.ok) return res.error
    set({ list: res.list })
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
