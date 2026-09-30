import type {
  ExtensionInfo,
  ExtensionSettingContribution,
  ExtensionSettingValue,
} from '@shared/extensions'
import { useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { useExtensionsStore } from '../stores/extensionsStore'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from './ui/select'
import { Switch } from './ui/switch'

export function ExtensionSettingsForm({ ext }: { ext: ExtensionInfo }): JSX.Element | null {
  const d = useDict()
  const setSetting = useExtensionsStore((s) => s.setSetting)
  const [error, setError] = useState<string | null>(null)
  if (ext.settings.length === 0) return null
  const save = (key: string, value: unknown): void => {
    void setSetting(ext.id, key, value).then(setError)
  }
  return (
    <fieldset
      className="mt-2 flex flex-col border-line border-l pl-3"
      aria-label={fmt(d.extensions.settingsTitle, { name: ext.name })}
    >
      {ext.settings.map((setting) => (
        <SettingRow
          key={setting.key}
          setting={setting}
          value={ext.settingValues[setting.key] ?? setting.default}
          onSave={(value) => save(setting.key, value)}
        />
      ))}
      {error ? (
        <p role="alert" className="mt-1 text-attn-fg text-ui-xs">
          {fmt(d.extensions.settingInvalid, { error })}
        </p>
      ) : null}
    </fieldset>
  )
}

function SettingRow({
  setting,
  value,
  onSave,
}: {
  setting: ExtensionSettingContribution
  value: ExtensionSettingValue
  onSave: (value: unknown) => void
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-6 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-fg text-ui-sm">{setting.key}</div>
        <p className="mt-0.5 text-fg-muted text-ui-xs">{setting.description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SettingControl setting={setting} value={value} onSave={onSave} />
      </div>
    </div>
  )
}

function SettingControl({
  setting,
  value,
  onSave,
}: {
  setting: ExtensionSettingContribution
  value: ExtensionSettingValue
  onSave: (value: unknown) => void
}): JSX.Element {
  if (setting.type === 'boolean') {
    return <Switch checked={value === true} onCheckedChange={onSave} aria-label={setting.key} />
  }
  if (setting.type === 'enum') {
    return (
      <Select value={String(value)} onValueChange={(v) => onSave(v)}>
        <SelectTrigger size="sm" aria-label={setting.key} className="w-44">
          {String(value)}
        </SelectTrigger>
        <SelectContent>
          {(setting.values ?? []).map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  return <TextControl setting={setting} value={value} onSave={onSave} />
}

function TextControl({
  setting,
  value,
  onSave,
}: {
  setting: ExtensionSettingContribution
  value: ExtensionSettingValue
  onSave: (value: unknown) => void
}): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const numeric = setting.type === 'number'
  const commit = (): void => {
    if (draft === String(value)) return
    const n = Number(draft)
    if (!numeric) onSave(draft)
    else if (draft.trim() && Number.isFinite(n)) onSave(n)
    else setDraft(String(value))
  }
  return (
    <Input
      type={numeric ? 'number' : 'text'}
      value={draft}
      aria-label={setting.key}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      className={`h-7 font-mono ${numeric ? 'w-24' : 'w-56'}`}
    />
  )
}
