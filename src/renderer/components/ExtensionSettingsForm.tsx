import { cn } from '@/lib/utils'
import type {
  ExtensionInfo,
  ExtensionSecretContribution,
  ExtensionSettingContribution,
  ExtensionSettingValue,
} from '@shared/extensions'
import { useEffect, useState } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict, withProductName } from '../i18n/useDict'
import { entryTitle, enumValueTitle } from '../lib/extensionSettingText'
import { useExtensionsStore } from '../stores/extensionsStore'
import { ControlRow, SelectField } from './SettingsPanel'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'

export function ExtensionSettingsForm({
  ext,
  omit = [],
  bare = false,
}: {
  ext: ExtensionInfo
  omit?: readonly string[]
  bare?: boolean
}): JSX.Element | null {
  const d = useDict()
  const setSetting = useExtensionsStore((s) => s.setSetting)
  const [error, setError] = useState<string | null>(null)
  const settings = ext.settings.filter((s) => !omit.includes(s.key))
  if (settings.length === 0 && ext.secrets.length === 0) return null
  const save = (key: string, value: unknown): void => {
    void setSetting(ext.id, key, value).then(setError)
  }
  return (
    <fieldset
      className={cn('flex flex-col', !bare && 'mt-2 border-line border-l pl-3')}
      aria-label={fmt(d.extensions.settingsTitle, { name: ext.name })}
    >
      {settings.map((setting) => (
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
        <p role="alert" className="mt-1 text-attn-fg text-ui-sm">
          {fmt(d.extensions.settingInvalid, { error })}
        </p>
      ) : null}
    </fieldset>
  )
}

function KeyHint({ name }: { name: string }): JSX.Element {
  return <span className="truncate font-mono text-fg-muted text-ui-xs">{name}</span>
}

export function settingBounds(d: Dict, setting: ExtensionSettingContribution): string | null {
  const { minimum: min, maximum: max, unit } = setting
  const range =
    min !== undefined && max !== undefined
      ? fmt(d.extensions.rangeBetween, { min, max })
      : min !== undefined
        ? fmt(d.extensions.rangeAtLeast, { min })
        : max !== undefined
          ? fmt(d.extensions.rangeAtMost, { max })
          : null
  if (!range) return null
  const text =
    unit === 'seconds'
      ? fmt(d.extensions.unitSeconds, { range })
      : unit === 'per-minute'
        ? fmt(d.extensions.unitPerMinute, { range })
        : range
  return fmt(d.extensions.bounds, { text })
}

function settingDescription(d: Dict, setting: ExtensionSettingContribution): string {
  const description = withProductName(setting.description)
  const bounds = settingBounds(d, setting)
  return bounds ? fmt(d.extensions.describedBounds, { description, bounds }) : description
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
  const title = entryTitle(secret)
  const store = (value: string | null): void => {
    void setSecret(extId, secret.key, value).then((problem) => {
      setError(problem)
      if (!problem) setDraft('')
    })
  }
  return (
    <ControlRow
      label={title}
      labelHint={
        <>
          <KeyHint name={secret.key} />
          <span className={saved ? 'text-fg text-ui-xs' : 'text-fg-muted text-ui-xs'}>
            {saved ? d.assist.secretSaved : d.assist.secretUnset}
          </span>
        </>
      }
      desc={withProductName(secret.description)}
      error={error ? fmt(d.assist.secretError, { error }) : null}
    >
      <form
        className="flex items-center gap-2"
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
          aria-label={title}
          placeholder={d.assist.secretPlaceholder}
          onChange={(e) => setDraft(e.target.value)}
          className="h-7 w-44 font-mono text-ui-sm"
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
    </ControlRow>
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
  const d = useDict()
  const title = entryTitle(setting)
  return (
    <ControlRow
      label={title}
      labelHint={<KeyHint name={setting.key} />}
      desc={settingDescription(d, setting)}
    >
      <SettingControl setting={setting} title={title} value={value} onSave={onSave} />
    </ControlRow>
  )
}

function SettingControl({
  setting,
  title,
  value,
  onSave,
}: {
  setting: ExtensionSettingContribution
  title: string
  value: ExtensionSettingValue
  onSave: (value: unknown) => void
}): JSX.Element {
  if (setting.type === 'boolean') {
    return <Switch checked={value === true} onCheckedChange={onSave} aria-label={title} />
  }
  if (setting.type === 'enum') {
    return (
      <SelectField
        value={String(value)}
        onChange={onSave}
        label={title}
        options={(setting.values ?? []).map((option) => ({
          value: option,
          label: enumValueTitle(setting, option),
        }))}
      />
    )
  }
  if (setting.type === 'number') {
    return <NumberControl setting={setting} title={title} value={value} onSave={onSave} />
  }
  return <TextControl title={title} value={value} onSave={onSave} />
}

function clampToBounds(setting: ExtensionSettingContribution, n: number): number {
  const low = setting.minimum ?? Number.NEGATIVE_INFINITY
  const high = setting.maximum ?? Number.POSITIVE_INFINITY
  return Math.min(high, Math.max(low, n))
}

function NumberControl({
  setting,
  title,
  value,
  onSave,
}: {
  setting: ExtensionSettingContribution
  title: string
  value: ExtensionSettingValue
  onSave: (value: unknown) => void
}): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const n = Number(draft)
    if (!draft.trim() || !Number.isFinite(n)) {
      setDraft(String(value))
      return
    }
    const next = clampToBounds(setting, n)
    setDraft(String(next))
    if (next !== value) onSave(next)
  }
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={setting.minimum}
      max={setting.maximum}
      value={draft}
      aria-label={title}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      className="h-7 w-24 font-mono"
    />
  )
}

function TextControl({
  title,
  value,
  onSave,
}: {
  title: string
  value: ExtensionSettingValue
  onSave: (value: unknown) => void
}): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    if (draft !== String(value)) onSave(draft)
  }
  return (
    <Input
      value={draft}
      spellCheck={false}
      aria-label={title}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      className="h-7 w-56 font-mono text-ui-sm"
    />
  )
}
