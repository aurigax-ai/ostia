import { create } from 'zustand'
import { releaseFocusForPalette } from '../lib/paletteFocus'
import { parseSettingsTarget } from '../lib/settingsNav'

export type PaletteOpenMode = 'search' | 'ask'

export interface OpenSettingsOptions {
  previewPaneId?: string
  extension?: string
}

interface UIState {
  paletteOpen: boolean
  paletteMode: PaletteOpenMode
  paletteSeed: string
  railCollapsed: boolean
  settingsTabOpen: boolean
  settingsActive: boolean
  settingsSection: string | null
  settingsExtension: string | null
  dashboardActive: boolean
  filesOpen: boolean
  filesSearchOpen: boolean
  filesSearchFocus: boolean
  digitHints: boolean
  promptPreviewPaneId: string | null
  settingsWorkspaceId: string | null
  settingsRequest: number
  openPalette: (mode?: PaletteOpenMode, seed?: string) => void
  setPaletteMode: (mode: PaletteOpenMode) => void
  closePalette: () => void
  togglePalette: () => void
  toggleRail: () => void
  setRailCollapsed: (collapsed: boolean) => void
  openSettings: (section?: string, options?: OpenSettingsOptions) => void
  openWorkspaceSettings: (workspaceId: string) => void
  closeSettings: () => void
  showWorkspaces: () => void
  openDashboard: () => void
  toggleDashboard: () => void
  toggleFiles: () => void
  showFiles: () => void
  searchFiles: () => void
  closeFilesSearch: () => void
  filesSearchFocused: () => void
  setDigitHints: (shown: boolean) => void
}

export const useUIStore = create<UIState>((set, get) => ({
  paletteOpen: false,
  paletteMode: 'search',
  paletteSeed: '',
  railCollapsed: false,
  settingsTabOpen: false,
  settingsActive: false,
  settingsSection: null,
  settingsExtension: null,
  dashboardActive: false,
  filesOpen: false,
  filesSearchOpen: false,
  filesSearchFocus: false,
  digitHints: false,
  promptPreviewPaneId: null,
  settingsWorkspaceId: null,
  settingsRequest: 0,
  openPalette: (mode = 'search', seed = '') => {
    if (!get().paletteOpen) releaseFocusForPalette()
    set({ paletteOpen: true, paletteMode: mode, paletteSeed: seed })
  },
  setPaletteMode: (paletteMode) => set({ paletteMode }),
  closePalette: () => set({ paletteOpen: false, paletteMode: 'search', paletteSeed: '' }),
  togglePalette: () => {
    if (!get().paletteOpen) releaseFocusForPalette()
    set((s) => ({ paletteOpen: !s.paletteOpen, paletteMode: 'search', paletteSeed: '' }))
  },
  toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
  setRailCollapsed: (railCollapsed) => set({ railCollapsed }),
  openSettings: (section, options = {}) => {
    const target = parseSettingsTarget(section, options.extension)
    set({
      settingsTabOpen: true,
      settingsActive: true,
      dashboardActive: false,
      settingsSection: target.section,
      settingsExtension: target.extension,
      promptPreviewPaneId: options.previewPaneId ?? null,
    })
  },
  openWorkspaceSettings: (workspaceId) =>
    set((s) => ({
      settingsTabOpen: true,
      settingsActive: true,
      dashboardActive: false,
      settingsWorkspaceId: workspaceId,
      settingsRequest: s.settingsRequest + 1,
    })),
  closeSettings: () => set({ settingsTabOpen: false, settingsActive: false }),
  showWorkspaces: () => set({ settingsActive: false, dashboardActive: false }),
  openDashboard: () => set({ dashboardActive: true, settingsActive: false }),
  toggleDashboard: () =>
    set((s) => ({ dashboardActive: !s.dashboardActive, settingsActive: false })),
  toggleFiles: () => set((s) => ({ filesOpen: !s.filesOpen, filesSearchFocus: false })),
  showFiles: () => set({ filesOpen: true }),
  searchFiles: () => set({ filesOpen: true, filesSearchOpen: true, filesSearchFocus: true }),
  closeFilesSearch: () => set({ filesSearchOpen: false, filesSearchFocus: false }),
  filesSearchFocused: () => set({ filesSearchFocus: false }),
  setDigitHints: (digitHints) => set({ digitHints }),
}))

export function coversWorkspaces(
  state: Pick<UIState, 'settingsActive' | 'dashboardActive'>,
): boolean {
  return state.settingsActive || state.dashboardActive
}
