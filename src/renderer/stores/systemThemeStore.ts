import { create } from 'zustand'

interface SystemThemeState {
  dark: boolean
  init: () => Promise<void>
}

export const useSystemThemeStore = create<SystemThemeState>((set) => ({
  dark: true,
  init: async () => {
    window.pine.window.onSystemDarkChange((dark) => set({ dark }))
    set({ dark: await window.pine.window.isSystemDark() })
  },
}))
