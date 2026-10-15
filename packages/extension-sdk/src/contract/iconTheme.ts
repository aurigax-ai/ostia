export const BUILTIN_ICON_THEME = 'ostia'

export const ICON_THEME_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export interface IconThemeContribution {
  id: string
  label: string
  path: string
}

export interface IconThemeInfo {
  id: string
  label: string
}

export interface IconAssociations {
  file?: string
  folder?: string
  folderExpanded?: string
  fileExtensions: Record<string, string>
  fileNames: Record<string, string>
  folderNames: Record<string, string>
  folderNamesExpanded: Record<string, string>
  languageIds: Record<string, string>
}

export interface LoadedIconTheme {
  id: string
  label: string
  icons: Record<string, string>
  base: IconAssociations
  light?: IconAssociations
  highContrast?: IconAssociations
}

export interface IconThemesApi {
  load: (id: string) => Promise<LoadedIconTheme | null>
}
