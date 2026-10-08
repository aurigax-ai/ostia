import type {
  ExtensionInfo,
  ExtensionSidebarItem,
  PaneChip,
  WorkspaceChip,
} from '@shared/extensions'
import { type CoreItems, NO_CORE_ITEMS } from '@shared/git'
import { create } from 'zustand'
import { useSettingsStore } from './settingsStore'

export interface PanelNavigation {
  path: string
  seq: number
}

interface Contributed {
  sidebar: ExtensionSidebarItem[]
  chips: PaneChip[]
  workspaceChips: WorkspaceChip[]
}

function shown(
  git: CoreItems,
  ports: CoreItems,
  contributed: Contributed,
): Pick<ExtensionsState, 'sidebar' | 'chips' | 'workspaceChips'> {
  return {
    sidebar: [...git.sidebar, ...ports.sidebar, ...contributed.sidebar],
    chips: [...git.paneChips, ...ports.paneChips, ...contributed.chips],
    workspaceChips: [...git.workspaceChips, ...ports.workspaceChips, ...contributed.workspaceChips],
  }
}

interface ExtensionsState {
  list: ExtensionInfo[]
  git: CoreItems
  ports: CoreItems
  contributed: Contributed
  setGitItems: (items: CoreItems) => void
  setPortsItems: (items: CoreItems) => void
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
  git: NO_CORE_ITEMS,
  ports: NO_CORE_ITEMS,
  contributed: { sidebar: [], chips: [], workspaceChips: [] },
  setGitItems: (git) => set((s) => ({ git, ...shown(git, s.ports, s.contributed) })),
  setPortsItems: (ports) => set((s) => ({ ports, ...shown(s.git, ports, s.contributed) })),
  sidebar: [],
  chips: [],
  workspaceChips: [],
  panelNav: {},
  reviewing: null,
  dismissed: [],

  setList: (list) => set({ list }),
  setSidebar: (sidebar) =>
    set((s) => {
      const contributed = { ...s.contributed, sidebar }
      return { contributed, ...shown(s.git, s.ports, contributed) }
    }),
  setChips: (chips) =>
    set((s) => {
      const contributed = { ...s.contributed, chips }
      return { contributed, ...shown(s.git, s.ports, contributed) }
    }),
  setWorkspaceChips: (workspaceChips) =>
    set((s) => {
      const contributed = { ...s.contributed, workspaceChips }
      return { contributed, ...shown(s.git, s.ports, contributed) }
    }),

  navigatePanel: (paneId, path) =>
    set((s) => ({ panelNav: { ...s.panelNav, [paneId]: { path, seq: ++navSeq } } })),

  load: async () => {
    const [list, sidebar, chips, workspaceChips] = await Promise.all([
      window.ostia.extensions.list(),
      window.ostia.extensions.sidebarItems(),
      window.ostia.extensions.paneChips(),
      window.ostia.extensions.workspaceChips(),
    ])
    set((s) => {
      const contributed = { sidebar, chips, workspaceChips }
      return { list, contributed, ...shown(s.git, s.ports, contributed) }
    })
  },

  setEnabled: async (extId, enabled) => {
    set({ list: await window.ostia.extensions.setEnabled(extId, enabled) })
  },

  setSetting: async (extId, key, value) => {
    const res = await window.ostia.extensions.setSetting(extId, key, value)
    if (!res.ok) return res.error
    set({ list: res.list })
    useSettingsStore.getState().setExtensionSettings(extId, res.stored)
    return null
  },

  setSecret: async (extId, key, value) => {
    const res = await window.ostia.extensions.setSecret(extId, key, value)
    if (!res.ok) return res.error
    set({ list: res.list })
    return null
  },

  approve: async (extId) => {
    const list = await window.ostia.extensions.approve(extId)
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
