import { XIcon } from '@phosphor-icons/react'
import type { JSX } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Badge } from '@/components/ui/badge'
import { viewIcon } from '@/components/views/viewIcons'
import { fmt, useDict } from '@/lib/app/useDict'
import { actionFingerprint } from '@/lib/settings/actions'
import { useSettingsStore } from '@/stores/app/settingsStore'

export function ActionsSection(): JSX.Element {
  const d = useDict()
  const actions = useSettingsStore((s) => s.actions)
  const trusted = useSettingsStore((s) => s.trustedActions)
  const remove = useSettingsStore((s) => s.removeAction)

  return (
    <div className="mt-6">
      <SettingsPage title={d.actions.settingsTitle} desc={d.actions.settingsDesc}>
        <SettingsList label={d.actions.settingsTitle} empty={d.actions.none}>
          {actions.map((action) => {
            const Icon = viewIcon(action.icon ?? 'lightning')
            const places = action.in.map((p) => d.actions.places[p] ?? p)
            return (
              <SettingsListRow
                key={action.id}
                lead={<Icon size={16} aria-hidden />}
                title={action.title}
                meta={
                  trusted.includes(actionFingerprint(action)) ? (
                    <Badge variant="outline" className="text-ui-xs">
                      {d.actions.trusted}
                    </Badge>
                  ) : null
                }
                detail={
                  <span className="block truncate font-mono text-ui-xs">
                    {action.command}
                    {places.length > 0 ? ` · ${places.join(', ')}` : ''}
                  </span>
                }
                actions={
                  <IconButton
                    icon={XIcon}
                    label={fmt(d.actions.remove, { title: action.title })}
                    onClick={() => remove(action.id)}
                  />
                }
              />
            )
          })}
        </SettingsList>
      </SettingsPage>
    </div>
  )
}
