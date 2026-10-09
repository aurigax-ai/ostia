import { type Dict, mergeCatalog } from '../../shared/app/dict'
import { type LanguagePackDeps, loadLanguagePacks } from './languagePacks'

export interface MainStringsDeps extends LanguagePackDeps {
  locale: () => string | undefined
}

export function createMainStrings(deps: MainStringsDeps): () => Dict {
  const english = mergeCatalog({})
  let loaded: { key: string; dict: Dict } | null = null
  return () => {
    const locale = deps.locale()
    if (!locale || locale === 'en') return english
    const sources = deps.languages()
    const key = JSON.stringify([
      locale,
      sources.map(({ extId, dir, language }) => [extId, dir, language.id, language.path]),
    ])
    if (loaded?.key === key) return loaded.dict
    const pack = loadLanguagePacks({ languages: () => sources, onError: deps.onError }).find(
      (p) => p.id === locale,
    )
    const dict = pack ? mergeCatalog(pack.catalog) : english
    loaded = { key, dict }
    return dict
  }
}
