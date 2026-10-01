import type { LanguageCatalog, LanguagePack } from '@shared/languagePack'
import { type Dict, en } from '../i18n/dict'
import type { LanguageContribution } from '../plugins/types'

export const BASE_LANGUAGE: LanguageContribution = { id: 'en', label: 'English', catalog: en }

type Strings = { [key: string]: string | Strings }

function mergeStrings(base: Strings, catalog: LanguageCatalog | undefined): Strings {
  const out: Strings = {}
  for (const [key, value] of Object.entries(base)) {
    const translated = catalog && Object.hasOwn(catalog, key) ? catalog[key] : undefined
    if (typeof value === 'string') {
      out[key] = typeof translated === 'string' ? translated : value
    } else {
      out[key] = mergeStrings(value, typeof translated === 'object' ? translated : undefined)
    }
  }
  return out
}

export function mergeCatalog(catalog: LanguageCatalog): Dict {
  return mergeStrings(en as unknown as Strings, catalog) as unknown as Dict
}

export function languagesFrom(packs: LanguagePack[]): LanguageContribution[] {
  const languages = [BASE_LANGUAGE]
  for (const pack of packs) {
    if (languages.some((l) => l.id === pack.id)) continue
    languages.push({ id: pack.id, label: pack.label, catalog: mergeCatalog(pack.catalog) })
  }
  return languages
}
