export const LANGUAGE_ID_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/

export interface LanguageContribution {
  id: string
  label: string
  path: string
}

export interface LanguageInfo {
  id: string
  label: string
}

export interface LanguageCatalog {
  [key: string]: string | LanguageCatalog
}

export interface LanguagePack {
  extId: string
  id: string
  label: string
  catalog: LanguageCatalog
}

export interface LanguagePacksApi {
  load: () => Promise<LanguagePack[]>
}
