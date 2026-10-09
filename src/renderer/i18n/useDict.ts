import { BASE_LANGUAGE } from '@/lib/extensions/languagePacks'
import type { Dict } from '@shared/dict'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'

export { fmt, withProductName } from '@shared/dict'

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
