import type { Dict } from '../i18n/dict'

/**
 * Plugin contribution model (Phase A — declarative). A plugin contributes to well-known
 * extension points; the app aggregates built-in + installed plugins into one registry.
 * "Core is just a plugin": the built-in themes and language servers ship as builtin plugins.
 */

/** A color theme: overrides for the --color-* primitives (key without the --color- prefix). */
export interface Theme {
  id: string
  name: string
  appearance: 'dark' | 'light'
  tokens: Record<string, string>
}

/** A language server a plugin contributes; the spawn config + status live in main. */
export interface LanguageServerSpec {
  languageId: string
  label: string
}

/** A UI language pack: a locale id, its display label, and the full string catalog. */
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
  /** Built-in (ships with Pine) vs user-installed. */
  builtin: boolean
  contributes: PluginContributions
}
