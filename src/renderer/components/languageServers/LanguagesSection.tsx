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
      {servers.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{t.none}</p>
      ) : (
        <ul className="-mx-3 flex flex-col">
          {servers.map((server) => (
            <ServerRow key={server.key} server={server} />
          ))}
        </ul>
      )}
    </SettingsPage>
  )
}
