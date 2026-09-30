import { XIcon } from '@phosphor-icons/react'
import { fmt, useDict } from '../i18n/useDict'
import { actionFingerprint } from '../settings/actions'
import { useSettingsStore } from '../stores/settingsStore'
import { IconButton } from './IconButton'
import { SectionHead } from './SettingsPanel'
import { actionIcon } from './actionIcons'
import { Badge } from './ui/badge'

export function ActionsSection(): JSX.Element {
  const d = useDict()
  const actions = useSettingsStore((s) => s.actions)
  const trusted = useSettingsStore((s) => s.trustedActions)
  const remove = useSettingsStore((s) => s.removeAction)

  return (
    <section aria-label={d.actions.settingsTitle} className="mt-6">
      <SectionHead title={d.actions.settingsTitle} desc={d.actions.settingsDesc} />
      {actions.length === 0 ? (
        <p className="py-2 text-fg-muted text-ui-sm">{d.actions.none}</p>
      ) : (
        <ul className="flex flex-col">
          {actions.map((action) => {
            const Icon = actionIcon(action.icon)
            const places = action.in.map((p) => d.actions.places[p] ?? p)
            return (
              <li key={action.id} className="flex items-center gap-3 rounded-sm px-3 py-2">
                <Icon size={14} className="shrink-0 text-fg-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-fg text-ui-base">{action.title}</span>
                    {trusted.includes(actionFingerprint(action)) ? (
                      <Badge variant="outline" className="text-ui-xs">
                        {d.actions.trusted}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="truncate font-mono text-fg-muted text-ui-xs">
                    {action.command}
                    {places.length > 0 ? ` · ${places.join(', ')}` : ''}
                  </p>
                </div>
                <IconButton
                  icon={XIcon}
                  label={fmt(d.actions.remove, { title: action.title })}
                  onClick={() => remove(action.id)}
                />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
