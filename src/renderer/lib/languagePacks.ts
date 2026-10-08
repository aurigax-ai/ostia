import { mergeCatalog } from '@shared/dict'
import type { LanguagePack } from '@shared/languagePack'
import type { LanguageContribution } from '../plugins/types'

export const BASE_LANGUAGE: LanguageContribution = {
  id: 'en',
  label: 'English',
  catalog: mergeCatalog({}),
}

export function languagesFrom(packs: LanguagePack[]): LanguageContribution[] {
  const languages = [BASE_LANGUAGE]
  for (const pack of packs) {
    if (languages.some((l) => l.id === pack.id)) continue
    languages.push({ id: pack.id, label: pack.label, catalog: mergeCatalog(pack.catalog) })
  }
  return languages
}
