import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { type Dict, en } from './dict'

export { fmt } from './dict'

/**
 * The active locale's catalog, resolved against the language registry (each language is a
 * plugin). Falls back to the first pack, then English, if the locale is unknown.
 */
export function useDict(): Dict {
  const locale = useSettingsStore((s) => s.locale)
  const languages = usePluginsStore((s) => s.languages)
  return (languages.find((l) => l.id === locale) ?? languages[0])?.catalog ?? en
}
