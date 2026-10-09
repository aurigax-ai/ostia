import type { ViewInfo, ViewListing } from '@shared/views/views'
import { create } from 'zustand'

interface ViewsState {
  dir: string
  views: ViewInfo[]
  collapsed: Record<string, boolean>
  apply: (listing: ViewListing) => void
  load: () => Promise<void>
  setEnabled: (name: string, enabled: boolean) => Promise<void>
  toggleCollapsed: (name: string) => void
}

export const useViewsStore = create<ViewsState>((set) => ({
  dir: '',
  views: [],
  collapsed: {},
  apply: (listing) => set({ dir: listing.dir, views: listing.views }),
  load: async () => {
    const listing = await window.ostia.views.list()
    set({ dir: listing.dir, views: listing.views })
  },
  setEnabled: async (name, enabled) => {
    const listing = await window.ostia.views.setEnabled(name, enabled)
    set({ dir: listing.dir, views: listing.views })
  },
  toggleCollapsed: (name) =>
    set((s) => ({ collapsed: { ...s.collapsed, [name]: !s.collapsed[name] } })),
}))

export function enabledViews(
  views: readonly ViewInfo[],
  placement: 'sidebar' | 'panel',
): ViewInfo[] {
  return views.filter((v) => v.status === 'enabled' && v.doc?.placement === placement)
}
