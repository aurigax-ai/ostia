import { create } from 'zustand'

/** Which view the sidebar shows (switched by the rail's top buttons). */
export type SidebarView = 'sessions' | 'files'

interface UIState {
  paletteOpen: boolean
  railCollapsed: boolean
  inspectorOpen: boolean
  /** The Settings tab exists in the sidebar (persists until explicitly closed via its ×). */
  settingsTabOpen: boolean
  /** Settings is the current center view (its tab is selected). */
  settingsActive: boolean
  sidebarView: SidebarView
  openPalette: () => void
  closePalette: () => void
  togglePalette: () => void
  toggleRail: () => void
  toggleInspector: () => void
  /** Open the Settings tab and select it. */
  openSettings: () => void
  /** Close the Settings tab entirely (the × on the tab). */
  closeSettings: () => void
  /** Deselect Settings (a session tab was selected) without closing the tab. */
  leaveSettings: () => void
  setSidebarView: (view: SidebarView) => void
}

export const useUIStore = create<UIState>((set) => ({
  paletteOpen: false,
  railCollapsed: false,
  inspectorOpen: true,
  settingsTabOpen: false,
  settingsActive: false,
  sidebarView: 'sessions',
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  openSettings: () => set({ settingsTabOpen: true, settingsActive: true }),
  closeSettings: () => set({ settingsTabOpen: false, settingsActive: false }),
  leaveSettings: () => set({ settingsActive: false }),
  setSidebarView: (sidebarView) => set({ sidebarView }),
}))
