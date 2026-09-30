import { create } from 'zustand'
import { BUILTIN_PLUGINS } from '../plugins/builtin'
import type { ColorScheme, LanguageContribution, PluginManifest, Theme } from '../plugins/types'

const collectThemes = (plugins: PluginManifest[]): Theme[] =>
  plugins.flatMap((p) => p.contributes.themes ?? [])
const collectColorSchemes = (plugins: PluginManifest[]): ColorScheme[] =>
  plugins.flatMap((p) => p.contributes.colorSchemes ?? [])
const collectLanguages = (plugins: PluginManifest[]): LanguageContribution[] =>
  plugins.flatMap((p) => p.contributes.languages ?? [])

export type LspStatus = 'running' | 'installed' | 'missing' | 'error'

export interface LspEntry {
  languageId: string
  command: string
  status: LspStatus
}

interface PluginsState {
  plugins: PluginManifest[]
  themes: Theme[]
  colorSchemes: ColorScheme[]
  languages: LanguageContribution[]
  lsp: LspEntry[]
  loaded: boolean
  load: () => Promise<void>
  setLspStatus: (languageId: string, status: LspStatus) => void
}

export const usePluginsStore = create<PluginsState>((set, get) => ({
  plugins: BUILTIN_PLUGINS,
  themes: collectThemes(BUILTIN_PLUGINS),
  colorSchemes: collectColorSchemes(BUILTIN_PLUGINS),
  languages: collectLanguages(BUILTIN_PLUGINS),
  lsp: [],
  loaded: false,

  load: async () => {
    if (get().loaded) return
    const servers = await window.pine.lsp.list()
    set({
      loaded: true,
      lsp: servers.map((s) => ({
        languageId: s.languageId,
        command: s.command,
        status: s.installed ? 'installed' : 'missing',
      })),
    })
  },

  setLspStatus: (languageId, status) =>
    set((st) => ({
      lsp: st.lsp.map((e) => (e.languageId === languageId ? { ...e, status } : e)),
    })),
}))
