import type {
  SandboxEditError,
  SandboxFixedPolicy,
  SandboxPathKind,
  SandboxSwitches,
} from '@shared/sandbox'
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
}: {
  scope: SandboxPolicyScope
  list: SandboxListKey
  label: string
  desc: string
  fixed?: readonly string[]
  placeholder: string
}): JSX.Element {
  return (
    <SandboxListEditor
      label={label}
      desc={desc}
      items={scope.items(list)}
      fixed={fixed}
      inherited={scope.inherited(list)}
      placeholder={placeholder}
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

export function SandboxFilesGroups({ scope }: { scope: SandboxPolicyScope }): JSX.Element {
  const d = useDict()
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
        />
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
