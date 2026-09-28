import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { type Dict, en } from './dict'

export { fmt } from './dict'

export function useDict(): Dict {
  const locale = useSettingsStore((s) => s.locale)
  const languages = usePluginsStore((s) => s.languages)
  return (languages.find((l) => l.id === locale) ?? languages[0])?.catalog ?? en
}
