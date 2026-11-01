import { XIcon } from '@phosphor-icons/react'
import type { JSX } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { ToggleRow } from '@/components/settingsKit/ControlRow'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { fmt, useDict } from '@/lib/app/useDict'
import { useSettingsStore } from '@/stores/app/settingsStore'

export function TerminalLinksGroup(): JSX.Element {
  const d = useDict()
  const ask = useSettingsStore((s) => s.terminal.askBeforeOpeningApps)
  const allowed = useSettingsStore((s) => s.terminal.allowedAppSchemes)
  const setTerminal = useSettingsStore((s) => s.setTerminal)
  return (
    <SettingsGroup title={d.settings.groupLinks}>
      <ToggleRow
        label={d.settings.askAppLinks}
        desc={d.settings.askAppLinksDesc}
        checked={ask}
        onChange={(v) => setTerminal({ askBeforeOpeningApps: v })}
      />
      <SettingsList label={d.settings.allowedAppLinks} empty={d.settings.allowedAppLinksEmpty}>
        {allowed.map((scheme) => (
          <SettingsListRow
            key={scheme}
            title={<span className="font-mono">{`${scheme}:`}</span>}
            actions={
              <IconButton
                icon={XIcon}
                label={fmt(d.settings.removeAppLink, { scheme: `${scheme}:` })}
                onClick={() =>
                  setTerminal({ allowedAppSchemes: allowed.filter((s) => s !== scheme) })
                }
              />
            }
          />
        ))}
      </SettingsList>
    </SettingsGroup>
  )
}
