import { useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { usePluginsStore } from '@/stores/extensions/pluginsStore'
import type { Locale } from '@shared/app/dict'
import { ControlRow } from './ControlRow'
import { SelectField } from './SelectField'
import { SectionHead } from './SettingsGroup'

export function LanguageSection(): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const setLocale = useSettingsStore((s) => s.setLocale)
  const languages = usePluginsStore((s) => s.languages)
  return (
    <section>
      <SectionHead title={d.settings.language} />
      <ControlRow label={d.settings.displayLanguage}>
        <SelectField
          value={locale}
          onChange={(l) => setLocale(l as Locale)}
          label={d.settings.displayLanguage}
          options={languages.map((l) => ({ value: l.id, label: l.label }))}
        />
      </ControlRow>
    </section>
  )
}
