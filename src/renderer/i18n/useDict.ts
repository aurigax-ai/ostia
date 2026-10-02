import { BASE_LANGUAGE } from '../lib/languagePacks'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { Dict } from './dict'

export { fmt, withProductName } from './dict'

export function currentDict(): Dict {
  const locale = useSettingsStore.getState().locale
  const languages = usePluginsStore.getState().languages
  return (languages.find((l) => l.id === locale) ?? languages[0])?.catalog ?? BASE_LANGUAGE.catalog
}

export function useDict(): Dict {
  const locale = useSettingsStore((s) => s.locale)
  const languages = usePluginsStore((s) => s.languages)
  return (languages.find((l) => l.id === locale) ?? languages[0])?.catalog ?? BASE_LANGUAGE.catalog
}
