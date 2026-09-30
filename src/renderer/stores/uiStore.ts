import { create } from 'zustand'

export type PaletteOpenMode = 'search' | 'ask'

interface UIState {
  paletteOpen: boolean
  paletteMode: PaletteOpenMode
  railCollapsed: boolean
  settingsTabOpen: boolean
  settingsActive: boolean
  settingsSection: string | null
  filesOpen: boolean
  digitHints: boolean
  promptEditor: { paneId: string | null } | null
  settingsWorkspaceId: string | null
  settingsRequest: number
  openPalette: (mode?: PaletteOpenMode) => void
  setPaletteMode: (mode: PaletteOpenMode) => void
  closePalette: () => void
  togglePalette: () => void
  toggleRail: () => void
  openSettings: (section?: string) => void
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
  paletteMode: 'search',
  railCollapsed: false,
  settingsTabOpen: false,
  settingsActive: false,
  settingsSection: null,
  filesOpen: false,
  digitHints: false,
  promptEditor: null,
  settingsWorkspaceId: null,
  settingsRequest: 0,
  openPalette: (mode = 'search') => set({ paletteOpen: true, paletteMode: mode }),
  setPaletteMode: (paletteMode) => set({ paletteMode }),
  closePalette: () => set({ paletteOpen: false, paletteMode: 'search' }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen, paletteMode: 'search' })),
  toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
  openSettings: (section) =>
    set({ settingsTabOpen: true, settingsActive: true, settingsSection: section ?? null }),
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
