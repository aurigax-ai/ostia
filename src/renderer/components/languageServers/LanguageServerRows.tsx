import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { useEffect } from 'react'
import { SettingsSubgroup } from '@/components/settingsKit/SettingsGroup'
import { useDict } from '@/lib/app/useDict'
import { useLanguageServersStore } from '@/stores/extensions/languageServersStore'
import { ServerRow } from './ServerRow'

export function LanguageServerRows({ ext }: { ext: ExtensionInfo }): JSX.Element | null {
  const d = useDict()
  const servers = useLanguageServersStore((s) => s.list)
  const load = useLanguageServersStore((s) => s.load)
  const provides = ext.languageServers.length > 0
  useEffect(() => {
    if (!provides) return
    if (!useLanguageServersStore.getState().watching) void load()
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [provides, load])
  if (!provides) return null
  return (
    <>
      <div className="mt-3" />
      <SettingsSubgroup title={d.languageServers.runsTitle} />
      {servers
        .filter((server) => server.extId === ext.id)
        .map((server) => (
          <ServerRow key={server.key} server={server} />
        ))}
    </>
  )
}
