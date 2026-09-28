import { create } from 'zustand'

export type SidebarView = 'workspaces' | 'files'

interface UIState {
  paletteOpen: boolean
  railCollapsed: boolean
  settingsTabOpen: boolean
  settingsActive: boolean
  sidebarView: SidebarView
  openPalette: () => void
  closePalette: () => void
  togglePalette: () => void
  toggleRail: () => void
  openSettings: () => void
  closeSettings: () => void
  leaveSettings: () => void
  setSidebarView: (view: SidebarView) => void
}

export const useUIStore = create<UIState>((set) => ({
  paletteOpen: false,
  railCollapsed: false,
  settingsTabOpen: false,
  settingsActive: false,
  sidebarView: 'workspaces',
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
  openSettings: () => set({ settingsTabOpen: true, settingsActive: true }),
  closeSettings: () => set({ settingsTabOpen: false, settingsActive: false }),
  leaveSettings: () => set({ settingsActive: false }),
  setSidebarView: (sidebarView) => set({ sidebarView }),
}))
