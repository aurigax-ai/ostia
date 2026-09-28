import type { ExtensionInfo, ExtensionSidebarItem } from '@shared/extensions'
import { create } from 'zustand'

interface ExtensionsState {
  list: ExtensionInfo[]
  sidebar: ExtensionSidebarItem[]
  reviewing: string | null
  dismissed: string[]
  setList: (list: ExtensionInfo[]) => void
  setSidebar: (items: ExtensionSidebarItem[]) => void
  load: () => Promise<void>
  setEnabled: (extId: string, enabled: boolean) => Promise<void>
  approve: (extId: string) => Promise<void>
  review: (extId: string | null) => void
  dismiss: (extId: string) => void
}

export const useExtensionsStore = create<ExtensionsState>((set) => ({
  list: [],
  sidebar: [],
  reviewing: null,
  dismissed: [],

  setList: (list) => set({ list }),
  setSidebar: (sidebar) => set({ sidebar }),

  load: async () => {
    const [list, sidebar] = await Promise.all([
      window.pine.extensions.list(),
      window.pine.extensions.sidebarItems(),
    ])
    set({ list, sidebar })
  },

  setEnabled: async (extId, enabled) => {
    set({ list: await window.pine.extensions.setEnabled(extId, enabled) })
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
