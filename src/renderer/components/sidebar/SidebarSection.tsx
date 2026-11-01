import type { JSX } from 'react'
import { ToggleRow } from '@/components/settingsKit/ControlRow'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'

export function SidebarSection(): JSX.Element {
  const d = useDict()
  const sidebar = useSettingsStore((s) => s.sidebar)
  const set = useSettingsStore((s) => s.setSidebar)
  return (
    <SettingsPage title={d.settings.sidebar}>
      <SettingsGroup title={d.settings.groupRows}>
        <ToggleRow
          label={d.settings.sidebarPath}
          desc={d.settings.sidebarPathDesc}
          checked={sidebar.showPath}
          onChange={(v) => set({ showPath: v })}
        />
        <ToggleRow
          label={d.settings.sidebarMessage}
          desc={d.settings.sidebarMessageDesc}
          checked={sidebar.showMessage}
          onChange={(v) => set({ showMessage: v })}
        />
        <ToggleRow
          label={d.settings.sidebarDescription}
          desc={d.settings.sidebarDescriptionDesc}
          checked={sidebar.showDescription}
          onChange={(v) => set({ showDescription: v })}
        />
        <ToggleRow
          label={d.settings.sidebarItems}
          desc={d.settings.sidebarItemsDesc}
          checked={sidebar.showExtensionItems}
          onChange={(v) => set({ showExtensionItems: v })}
        />
        <ToggleRow
          label={d.settings.sidebarSsh}
          desc={d.settings.sidebarSshDesc}
          checked={sidebar.showSSH}
          onChange={(v) => set({ showSSH: v })}
        />
      </SettingsGroup>
    </SettingsPage>
  )
}
