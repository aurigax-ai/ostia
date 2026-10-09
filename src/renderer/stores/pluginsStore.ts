import { BASE_LANGUAGE, languagesFrom } from '@/lib/extensions/languagePacks'
import { create } from 'zustand'
import { BUILTIN_PLUGINS } from '../plugins/builtin'
import type { ColorScheme, LanguageContribution, PluginManifest, Theme } from '../plugins/types'

const collectThemes = (plugins: PluginManifest[]): Theme[] =>
  plugins.flatMap((p) => p.contributes.themes ?? [])
const collectColorSchemes = (plugins: PluginManifest[]): ColorScheme[] =>
  plugins.flatMap((p) => p.contributes.colorSchemes ?? [])

interface PluginsState {
  plugins: PluginManifest[]
  themes: Theme[]
  colorSchemes: ColorScheme[]
  languages: LanguageContribution[]
  loadLanguages: () => Promise<void>
}

export const usePluginsStore = create<PluginsState>((set) => ({
  plugins: BUILTIN_PLUGINS,
  themes: collectThemes(BUILTIN_PLUGINS),
  colorSchemes: collectColorSchemes(BUILTIN_PLUGINS),
  languages: [BASE_LANGUAGE],

  loadLanguages: async () => {
    set({ languages: languagesFrom(await window.ostia.languagePacks.load()) })
  },
}))
