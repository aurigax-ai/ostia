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
  promptPreviewPaneId: string | null
  settingsWorkspaceId: string | null
  settingsRequest: number
  openPalette: (mode?: PaletteOpenMode) => void
  setPaletteMode: (mode: PaletteOpenMode) => void
  closePalette: () => void
  togglePalette: () => void
  toggleRail: () => void
  openSettings: (section?: string, previewPaneId?: string) => void
  openWorkspaceSettings: (workspaceId: string) => void
  closeSettings: () => void
  leaveSettings: () => void
  toggleFiles: () => void
  showFiles: () => void
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
  promptPreviewPaneId: null,
  settingsWorkspaceId: null,
  settingsRequest: 0,
  openPalette: (mode = 'search') => set({ paletteOpen: true, paletteMode: mode }),
  setPaletteMode: (paletteMode) => set({ paletteMode }),
  closePalette: () => set({ paletteOpen: false, paletteMode: 'search' }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen, paletteMode: 'search' })),
  toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
  openSettings: (section, previewPaneId) =>
    set({
      settingsTabOpen: true,
      settingsActive: true,
      settingsSection: section ?? null,
      promptPreviewPaneId: previewPaneId ?? null,
    }),
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
  setDigitHints: (digitHints) => set({ digitHints }),
}))
