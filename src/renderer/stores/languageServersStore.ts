import type {
  LanguageServerInfo,
  LanguageServerOverride,
  LanguageServerOverrideProblem,
} from '@shared/languageServers'
import { create } from 'zustand'

interface LanguageServersState {
  list: LanguageServerInfo[]
  watching: boolean
  load: () => Promise<void>
  setEnabled: (serverKey: string, enabled: boolean) => Promise<void>
  restart: (serverKey: string) => Promise<void>
  setOverride: (
    serverKey: string,
    override: LanguageServerOverride | null,
  ) => Promise<LanguageServerOverrideProblem | null>
}

export const useLanguageServersStore = create<LanguageServersState>((set, get) => ({
  list: [],
  watching: false,

  load: async () => {
    if (!get().watching) {
      set({ watching: true })
      window.pine.lsp.onServersChanged((list) => set({ list }))
    }
    set({ list: await window.pine.lsp.servers() })
  },

  setEnabled: async (serverKey, enabled) => {
    set({ list: await window.pine.lsp.setEnabled(serverKey, enabled) })
  },

  restart: async (serverKey) => {
    await window.pine.lsp.restart(serverKey)
    set({ list: await window.pine.lsp.servers() })
  },

  setOverride: async (serverKey, override) => {
    const result = await window.pine.lsp.setOverride(serverKey, override)
    set({ list: result.servers })
    return result.problem ?? null
  },
}))
