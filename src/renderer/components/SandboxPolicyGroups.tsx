import type {
  SandboxEditError,
  SandboxFixedPolicy,
  SandboxPathKind,
  SandboxSwitches,
} from '@shared/sandbox'
import {
  SANDBOX_READ_PRESETS,
  type SandboxReadPreset,
  presetIdOf,
  presetState,
  withPreset,
  withoutPreset,
} from '@shared/sandboxPresets'
import { useEffect, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { isMac } from '../platform'
import { type ListEditResult, SandboxListEditor } from './SandboxListEditor'
import { ControlRow, SettingsGroup, SubHead } from './SettingsPanel'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Switch } from './ui/switch'

export type SandboxListKey = SandboxPathKind | 'domains' | 'deniedDomains'

export interface SandboxPolicyScope {
  items: (key: SandboxListKey) => readonly string[]
  inherited: (key: SandboxListKey) => readonly string[]
  setList: (key: SandboxListKey, next: string[]) => Promise<ListEditResult>
  switches: SandboxSwitches
  overridden?: Partial<SandboxSwitches>
  setSwitch: (key: keyof SandboxSwitches, value: boolean | undefined) => void
  fixed: SandboxFixedPolicy | null
}

export function listErrors(errors: SandboxEditError[]): ListEditResult {
  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}

function ScopedList({
  scope,
  list,
  label,
  desc,
  fixed,
  placeholder,
  tagOf,
}: {
  scope: SandboxPolicyScope
  list: SandboxListKey
  label: string
  desc: string
  fixed?: readonly string[]
  placeholder: string
  tagOf?: (item: string) => string | undefined
}): JSX.Element {
  return (
    <SandboxListEditor
      label={label}
      desc={desc}
      items={scope.items(list)}
      fixed={fixed}
      inherited={scope.inherited(list)}
      placeholder={placeholder}
      tagOf={tagOf}
      onChange={(next) => scope.setList(list, next)}
    />
  )
}

function SwitchRow({
  scope,
  name,
  label,
  desc,
  disabled,
}: {
  scope: SandboxPolicyScope
  name: keyof SandboxSwitches
  label: string
  desc: string
  disabled?: boolean
}): JSX.Element {
  const d = useDict()
  const overridden = scope.overridden ? scope.overridden[name] !== undefined : undefined
  return (
    <fieldset aria-label={label}>
      <ControlRow label={label} desc={desc}>
        {overridden !== undefined ? (
          <Badge variant="outline">{overridden ? d.sandbox.overridden : d.sandbox.inherited}</Badge>
        ) : null}
        {overridden ? (
          <Button variant="ghost" size="xs" onClick={() => scope.setSwitch(name, undefined)}>
            {d.sandbox.reset}
          </Button>
        ) : null}
        <Switch
          aria-label={label}
          checked={scope.switches[name]}
          disabled={disabled}
          onCheckedChange={(checked) => scope.setSwitch(name, checked)}
        />
      </ControlRow>
    </fieldset>
  )
}

function useReadPresets(): SandboxReadPreset[] {
  const [presets, setPresets] = useState<SandboxReadPreset[]>([])
  useEffect(() => {
    let live = true
    void window.pine.sandbox.presets().then((found) => {
      if (live) setPresets(found)
    })
    return () => {
      live = false
    }
  }, [])
  return presets
}

function ReadPresets({
  scope,
  presets,
}: {
  scope: SandboxPolicyScope
  presets: readonly SandboxReadPreset[]
}): JSX.Element | null {
  const d = useDict()
  const [error, setError] = useState<string | null>(null)
  if (presets.length === 0) return null
  const own = scope.items('allowRead')
  const inherited = scope.inherited('allowRead')

  const toggle = async (preset: SandboxReadPreset, on: boolean): Promise<void> => {
    const next = on ? withPreset(own, preset, inherited) : withoutPreset(own, preset)
    const res = await scope.setList('allowRead', next)
    const reason = res.ok ? undefined : res.errors[0]?.reason
    setError(reason ? ((d.sandbox.errors as Record<string, string>)[reason] ?? reason) : null)
  }

  return (
    <fieldset aria-label={d.sandbox.presets} className="mb-4">
      <SubHead title={d.sandbox.presets} desc={d.sandbox.presetsDesc} />
      {presets.map((preset) => {
        const name = d.sandbox.presetNames[preset.id]
        const state = presetState(preset, own, inherited)
        return (
          <fieldset key={preset.id} aria-label={name}>
            <ControlRow label={name} desc={preset.paths.join(', ')}>
              {state === 'inherited' ? <Badge variant="outline">{d.sandbox.global}</Badge> : null}
              <Switch
                aria-label={name}
                checked={state !== 'off'}
                disabled={state === 'inherited'}
                onCheckedChange={(checked) => void toggle(preset, checked)}
              />
            </ControlRow>
          </fieldset>
        )
      })}
      {error ? (
        <p role="alert" className="mt-1 text-attn-fg text-ui-sm">
          {error}
        </p>
      ) : null}
    </fieldset>
  )
}

export function SandboxFilesGroups({ scope }: { scope: SandboxPolicyScope }): JSX.Element {
  const d = useDict()
  const presets = useReadPresets()
  const presetName = (path: string): string | undefined => {
    const id = presetIdOf(path, [...presets, ...SANDBOX_READ_PRESETS])
    return id ? d.sandbox.presetNames[id] : undefined
  }
  return (
    <>
      <SettingsGroup title={d.sandbox.reading} desc={d.sandbox.restartNote}>
        <ScopedList
          scope={scope}
          list="allowRead"
          label={d.sandbox.readPaths}
          desc={d.sandbox.readPathsDesc}
          fixed={scope.fixed?.readable}
          placeholder="~/.config/tool"
          tagOf={presetName}
        />
        <ReadPresets scope={scope} presets={presets} />
        <ScopedList
          scope={scope}
          list="denyRead"
          label={d.sandbox.hidePaths}
          desc={d.sandbox.hidePathsDesc}
          fixed={scope.fixed?.hidden}
          placeholder="~/.cargo/credentials.toml"
        />
      </SettingsGroup>
      <SettingsGroup title={d.sandbox.writing} desc={d.sandbox.restartNote}>
        <ScopedList
          scope={scope}
          list="allowWrite"
          label={d.sandbox.writePaths}
          desc={d.sandbox.writePathsDesc}
          fixed={scope.fixed?.writable}
          placeholder="~/builds"
        />
        <ScopedList
          scope={scope}
          list="denyWrite"
          label={d.sandbox.readOnlyPaths}
          desc={d.sandbox.readOnlyPathsDesc}
          fixed={scope.fixed?.readOnly}
          placeholder="~/builds/release"
        />
        <SwitchRow
          scope={scope}
          name="gitConfig"
          label={d.sandbox.gitConfig}
          desc={d.sandbox.gitConfigDesc}
        />
      </SettingsGroup>
    </>
  )
}

function HiddenSockets({ sockets }: { sockets: readonly string[] }): JSX.Element {
  const d = useDict()
  return (
    <fieldset aria-label={d.sandbox.hiddenSockets} className="mb-4">
      <SubHead title={d.sandbox.hiddenSockets} desc={d.sandbox.hiddenSocketsDesc} />
      {sockets.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.sandbox.hiddenSocketsEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {sockets.map((socket) => (
            <li key={socket} className="flex items-center gap-2 font-mono text-fg-muted text-ui-sm">
              <span className="min-w-0 flex-1 truncate">{socket}</span>
              <Badge variant="outline">{d.sandbox.always}</Badge>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  )
}

export function SandboxNetworkGroups({
  scope,
}: {
  scope: SandboxPolicyScope
}): JSX.Element {
  const d = useDict()
  const canBlock = scope.fixed?.socketBlocking ?? true
  return (
    <>
      <SettingsGroup title={d.sandbox.domainsGroup}>
        <ScopedList
          scope={scope}
          list="domains"
          label={d.sandbox.domains}
          desc={d.sandbox.domainsDesc}
          placeholder="api.example.com"
        />
        <ScopedList
          scope={scope}
          list="deniedDomains"
          label={d.sandbox.deniedDomains}
          desc={d.sandbox.deniedDomainsDesc}
          placeholder="telemetry.example.com"
        />
        <SwitchRow
          scope={scope}
          name="strictDomains"
          label={d.sandbox.strictDomains}
          desc={d.sandbox.strictDomainsDesc}
        />
      </SettingsGroup>
      <SettingsGroup title={d.sandbox.unixSockets} desc={d.sandbox.restartNote}>
        <SwitchRow
          scope={scope}
          name="unixSockets"
          label={d.sandbox.allowUnixSockets}
          desc={
            canBlock
              ? isMac
                ? d.sandbox.allowUnixSocketsMac
                : d.sandbox.allowUnixSocketsLinux
              : d.sandbox.unixSocketsUnsupported
          }
          disabled={!canBlock}
        />
        {isMac ? (
          <ScopedList
            scope={scope}
            list="allowSockets"
            label={d.sandbox.allowSockets}
            desc={d.sandbox.allowSocketsDesc}
            placeholder="/var/run/tool.sock"
          />
        ) : null}
        <HiddenSockets sockets={scope.fixed?.hiddenSockets ?? []} />
      </SettingsGroup>
    </>
  )
}
