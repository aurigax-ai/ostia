import { BASE_LANGUAGE } from '@/lib/extensions/languagePacks'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { usePluginsStore } from '@/stores/extensions/pluginsStore'
import type { Dict } from '@shared/app/dict'

export { fmt, withProductName } from '@shared/app/dict'

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
