import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { MagnifyingGlassIcon } from '@phosphor-icons/react'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { pageTitle } from '@/lib/settings/settingsSections'
import { useUIStore } from '@/stores/app/uiStore'
import { ExtensionSettingsForm } from './ExtensionSettingsForm'
import { type ExtensionAnchor, ExtensionsSection } from './InstalledExtensions'
import { MarketplacesGroup } from './MarketplaceSection'

export function ExtensionsPage({ anchor }: { anchor: ExtensionAnchor | null }): JSX.Element {
  const d = useDict()
  return (
    <SettingsPage
      title={d.settings.extensions}
      desc={d.extensions.desc}
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => useUIStore.getState().openBrowseExtensions()}
        >
          <MagnifyingGlassIcon data-icon="inline-start" />
          {d.extensions.browse}
        </Button>
      }
    >
      <ExtensionsSection anchor={anchor} />
      <MarketplacesGroup />
    </SettingsPage>
  )
}

export function ExtensionSettingsPage({ ext }: { ext: ExtensionInfo }): JSX.Element {
  const d = useDict()
  const title = pageTitle(ext)
  return (
    <SettingsPage title={title} desc={fmt(d.extensions.settingsPageFrom, { name: ext.name })}>
      <ExtensionSettingsForm ext={ext} bare />
    </SettingsPage>
  )
}
