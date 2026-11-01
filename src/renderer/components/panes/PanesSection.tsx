import type { JSX } from 'react'
import { ToggleRow } from '@/components/settingsKit/ControlRow'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'

export function PanesSection(): JSX.Element {
  const d = useDict()
  const panes = useSettingsStore((s) => s.panes)
  const set = useSettingsStore((s) => s.setPanes)
  return (
    <SettingsPage title={d.settings.panes}>
      <SettingsGroup title={d.settings.groupPaneFocus}>
        <ToggleRow
          label={d.settings.dimInactive}
          desc={d.settings.dimInactiveDesc}
          checked={panes.dimInactive}
          onChange={(v) => set({ dimInactive: v })}
        />
        <ToggleRow
          label={d.settings.focusOnHover}
          desc={d.settings.focusOnHoverDesc}
          checked={panes.focusOnHover}
          onChange={(v) => set({ focusOnHover: v })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupPaneLayout}>
        <ToggleRow
          label={d.settings.equalizeOnSplit}
          desc={d.settings.equalizeOnSplitDesc}
          checked={panes.equalizeOnSplit}
          onChange={(v) => set({ equalizeOnSplit: v })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupPaneTabs}>
        <ToggleRow
          label={d.settings.hideTabClose}
          desc={d.settings.hideTabCloseDesc}
          checked={panes.hideTabClose}
          onChange={(v) => set({ hideTabClose: v })}
        />
      </SettingsGroup>
    </SettingsPage>
  )
}
