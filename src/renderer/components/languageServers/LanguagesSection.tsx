import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { useDict } from '@/lib/app/useDict'
import { useLanguageServersStore } from '@/stores/extensions/languageServersStore'
import { useEffect } from 'react'
import { ServerRow } from './ServerRow'

export function LanguagesSection(): JSX.Element {
  const d = useDict()
  const t = d.languageServers
  const servers = useLanguageServersStore((s) => s.list)
  const load = useLanguageServersStore((s) => s.load)
  useEffect(() => {
    if (!useLanguageServersStore.getState().watching) void load()
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])
  return (
    <SettingsPage title={t.title} desc={t.desc}>
      <SettingsList label={t.title} empty={t.none}>
        {servers.map((server) => (
          <ServerRow key={server.key} server={server} />
        ))}
      </SettingsList>
    </SettingsPage>
  )
}
