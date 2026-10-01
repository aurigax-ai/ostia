import { ASSIST_POINTS } from '@shared/assist'
import type {
  ExtensionInfo,
  ExtensionSecretContribution,
  ExtensionSettingContribution,
  ExtensionSettingValue,
} from '@shared/extensions'
import { useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { useAssistStore } from '../stores/assistStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from './ui/select'
import { Switch } from './ui/switch'

export function ExtensionSettingsForm({ ext }: { ext: ExtensionInfo }): JSX.Element | null {
  const d = useDict()
  const setSetting = useExtensionsStore((s) => s.setSetting)
  const [error, setError] = useState<string | null>(null)
  if (ext.settings.length === 0 && ext.secrets.length === 0 && ext.assist.length === 0) return null
  const save = (key: string, value: unknown): void => {
    void setSetting(ext.id, key, value).then(setError)
  }
  return (
    <fieldset
      className="mt-2 flex flex-col border-line border-l pl-3"
      aria-label={fmt(d.extensions.settingsTitle, { name: ext.name })}
    >
      {ext.assist.length > 0 ? <AssistFeatures ext={ext} /> : null}
      {ext.settings.map((setting) => (
        <SettingRow
          key={setting.key}
          setting={setting}
          value={ext.settingValues[setting.key] ?? setting.default}
          onSave={(value) => save(setting.key, value)}
        />
      ))}
      {ext.secrets.map((secret) => (
        <SecretRow
          key={secret.key}
          extId={ext.id}
          secret={secret}
          saved={ext.secretsSet.includes(secret.key)}
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

function AssistFeatures({ ext }: { ext: ExtensionInfo }): JSX.Element {
  const d = useDict()
  const availability = useAssistStore((s) => s.availability)
  const points = ASSIST_POINTS.filter((p) => ext.assist.includes(p))
  return (
    <div className="py-1.5">
      <div className="font-medium text-fg text-ui-sm">{d.assist.features}</div>
      <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-0.5 text-ui-xs">
        {points.map((point) => {
          const provider = availability[point]
          const serving = provider?.extId === ext.id ? provider : null
          return (
            <div key={point} className="contents">
              <dt className="text-fg-muted">{d.assist.points[point] ?? point}</dt>
              <dd className={serving ? 'font-mono text-fg' : 'text-fg-muted'}>
                {serving ? (serving.label ?? serving.name) : d.assist.notConfigured}
              </dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}

function SecretRow({
  extId,
  secret,
  saved,
}: {
  extId: string
  secret: ExtensionSecretContribution
  saved: boolean
}): JSX.Element {
  const d = useDict()
  const setSecret = useExtensionsStore((s) => s.setSecret)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const store = (value: string | null): void => {
    void setSecret(extId, secret.key, value).then((problem) => {
      setError(problem)
      if (!problem) setDraft('')
    })
  }
  return (
    <div className="flex items-start justify-between gap-6 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-fg text-ui-sm">{secret.key}</span>
          <span className={saved ? 'text-fg text-ui-xs' : 'text-fg-muted text-ui-xs'}>
            {saved ? d.assist.secretSaved : d.assist.secretUnset}
          </span>
        </div>
        <p className="mt-0.5 text-fg-muted text-ui-xs">{secret.description}</p>
        {error ? (
          <p role="alert" className="mt-0.5 text-attn-fg text-ui-xs">
            {fmt(d.assist.secretError, { error })}
          </p>
        ) : null}
      </div>
      <form
        className="flex shrink-0 items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (draft) store(draft)
        }}
      >
        <Input
          type="password"
          value={draft}
          autoComplete="off"
          spellCheck={false}
          aria-label={secret.key}
          placeholder={d.assist.secretPlaceholder}
          onChange={(e) => setDraft(e.target.value)}
          className="h-7 w-44 font-mono"
        />
        <Button type="submit" variant="outline" size="sm" disabled={!draft}>
          {d.assist.secretSave}
        </Button>
        {saved ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => store(null)}>
            {d.assist.secretClear}
          </Button>
        ) : null}
      </form>
    </div>
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
        <SelectTrigger size="sm" aria-label={setting.key} className="w-fit min-w-44 max-w-80">
          <span className="min-w-0 truncate">{String(value)}</span>
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
