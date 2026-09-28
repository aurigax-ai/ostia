import type { Dict } from '../i18n/dict'

export interface Theme {
  id: string
  name: string
  appearance: 'dark' | 'light'
  tokens: Record<string, string>
}

export interface LanguageServerSpec {
  languageId: string
  label: string
}

export interface LanguageContribution {
  id: string
  label: string
  catalog: Dict
}

export interface PluginContributions {
  themes?: Theme[]
  languageServers?: LanguageServerSpec[]
  languages?: LanguageContribution[]
}

export interface PluginManifest {
  id: string
  name: string
  description: string
  version: string
  builtin: boolean
  contributes: PluginContributions
}
