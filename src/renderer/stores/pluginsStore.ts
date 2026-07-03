import { create } from 'zustand'
import { BUILTIN_PLUGINS } from '../plugins/builtin'
import type { LanguageContribution, PluginManifest, Theme } from '../plugins/types'

const collectThemes = (plugins: PluginManifest[]): Theme[] =>
  plugins.flatMap((p) => p.contributes.themes ?? [])
const collectLanguages = (plugins: PluginManifest[]): LanguageContribution[] =>
  plugins.flatMap((p) => p.contributes.languages ?? [])

/** running — active · installed — on PATH, idle · missing — not installed · error — crashed. */
export type LspStatus = 'running' | 'installed' | 'missing' | 'error'

export interface LspEntry {
  languageId: string
  command: string
  status: LspStatus
}

/**
 * The plugin/contribution registry. Holds installed plugins (built-in for now) and
 * aggregates their contributions (themes, language servers). Language-server status is
 * merged in from main (`lsp:list`) + the live LSP client.
 */
interface PluginsState {
  plugins: PluginManifest[]
  /** All contributed themes (stable reference; recomputed when plugins change). */
  themes: Theme[]
  /** All contributed language packs. */
  languages: LanguageContribution[]
  lsp: LspEntry[]
  loaded: boolean
  /** Fetch language-server availability from main (idempotent). */
  load: () => Promise<void>
  setLspStatus: (languageId: string, status: LspStatus) => void
}

export const usePluginsStore = create<PluginsState>((set, get) => ({
  plugins: BUILTIN_PLUGINS,
  themes: collectThemes(BUILTIN_PLUGINS),
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
