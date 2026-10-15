import { SectionHead } from '@/components/settings/SettingsGroup'
import { useSettingsSearch } from '@/components/settings/SettingsSearch'
import { fmt, useDict } from '@/lib/app/useDict'
import { pageTitle } from '@/lib/settings/settingsSections'
import type { ExtensionInfo } from '@shared/extensions'
import { BrowseExtensions } from './BrowseExtensions'
import { ExtensionSettingsForm } from './ExtensionSettingsForm'
import { type ExtensionAnchor, ExtensionsSection } from './InstalledExtensions'

export function ExtensionsPage({ anchor }: { anchor: ExtensionAnchor | null }): JSX.Element {
  const d = useDict()
  return (
    <section>
      <SectionHead title={d.settings.extensions} />
      <ExtensionsSection anchor={anchor} />
    </section>
  )
}

export function BrowseExtensionsPage(): JSX.Element | null {
  const search = useSettingsSearch()
  if (search && !search.forced) return null
  return <BrowseExtensions />
}

export function ExtensionSettingsPage({ ext }: { ext: ExtensionInfo }): JSX.Element {
  const d = useDict()
  const title = pageTitle(ext)
  return (
    <section aria-label={title}>
      <SectionHead title={title} desc={fmt(d.extensions.settingsPageFrom, { name: ext.name })} />
      <ExtensionSettingsForm ext={ext} bare />
    </section>
  )
}
