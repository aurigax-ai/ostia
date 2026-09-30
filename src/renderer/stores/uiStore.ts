import { create } from 'zustand'

interface UIState {
  paletteOpen: boolean
  railCollapsed: boolean
  settingsTabOpen: boolean
  settingsActive: boolean
  filesOpen: boolean
  digitHints: boolean
  promptEditor: { paneId: string | null } | null
  settingsWorkspaceId: string | null
  settingsRequest: number
  openPalette: () => void
  closePalette: () => void
  togglePalette: () => void
  toggleRail: () => void
  openSettings: () => void
  openWorkspaceSettings: (workspaceId: string) => void
  closeSettings: () => void
  leaveSettings: () => void
  toggleFiles: () => void
  showFiles: () => void
  openPromptEditor: (paneId: string | null) => void
  closePromptEditor: () => void
  setDigitHints: (shown: boolean) => void
}

export const useUIStore = create<UIState>((set) => ({
  paletteOpen: false,
  railCollapsed: false,
  settingsTabOpen: false,
  settingsActive: false,
  filesOpen: false,
  digitHints: false,
  promptEditor: null,
  settingsWorkspaceId: null,
  settingsRequest: 0,
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
  openSettings: () => set({ settingsTabOpen: true, settingsActive: true }),
  openWorkspaceSettings: (workspaceId) =>
    set((s) => ({
      settingsTabOpen: true,
      settingsActive: true,
      settingsWorkspaceId: workspaceId,
      settingsRequest: s.settingsRequest + 1,
    })),
  closeSettings: () => set({ settingsTabOpen: false, settingsActive: false }),
  leaveSettings: () => set({ settingsActive: false }),
  toggleFiles: () => set((s) => ({ filesOpen: !s.filesOpen })),
  showFiles: () => set({ filesOpen: true }),
  openPromptEditor: (paneId) => set({ promptEditor: { paneId } }),
  closePromptEditor: () => set({ promptEditor: null }),
  setDigitHints: (digitHints) => set({ digitHints }),
}))
