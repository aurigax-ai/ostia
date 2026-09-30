import { type SandboxGlobals, checkDomainPattern, parseSandboxGlobals } from '@shared/sandbox'
import { useDict } from '../i18n/useDict'
import { useSettingsStore } from '../stores/settingsStore'
import { type ListEditResult, SandboxListEditor } from './SandboxListEditor'
import { PortsPolicyRow } from './SandboxPortsTab'
import { ControlRow, SectionHead, SettingsGroup } from './SettingsPanel'
import { Select, SelectContent, SelectItem, SelectTrigger } from './ui/select'
import { Switch } from './ui/switch'

export function useSandboxGlobals(): SandboxGlobals {
  const raw = useSettingsStore((s) => s.sandbox)
  return parseSandboxGlobals(raw)
}

export function SandboxSection(): JSX.Element {
  const d = useDict()
  const globals = useSandboxGlobals()
  const save = useSettingsStore((s) => s.setSandbox)

  const setDomains = async (next: string[]): Promise<ListEditResult> => {
    const errors = next.flatMap((value) => {
      const check = checkDomainPattern(value)
      return check.ok ? [] : [{ value, reason: check.reason }]
    })
    if (errors.length > 0) return { ok: false, errors }
    await save({ ...globals, allowedDomains: next })
    return { ok: true }
  }

  const setReadPaths = async (next: string[]): Promise<ListEditResult> => {
    const errors = next.flatMap((value) =>
      value === '~' || value.startsWith('~/') || value.startsWith('/')
        ? []
        : [{ value, reason: 'not-absolute' }],
    )
    if (errors.length > 0) return { ok: false, errors }
    await save({ ...globals, allowRead: next })
    return { ok: true }
  }

  return (
    <div>
      <SectionHead title={d.sandbox.title} desc={d.sandbox.desc} />
      <SettingsGroup title={d.sandbox.network}>
        <SandboxListEditor
          label={d.sandbox.domains}
          desc={d.sandbox.domainsDesc}
          items={globals.allowedDomains}
          placeholder="api.example.com"
          onChange={setDomains}
        />
      </SettingsGroup>
      <SettingsGroup title={d.sandbox.files}>
        <SandboxListEditor
          label={d.sandbox.readPaths}
          desc={d.sandbox.readPathsDesc}
          items={globals.allowRead}
          placeholder="~/.config/tool"
          onChange={setReadPaths}
        />
      </SettingsGroup>
      <SettingsGroup title={d.sandbox.ports}>
        <PortsPolicyRow
          value={globals.portsPolicy ?? 'ask'}
          onChange={(portsPolicy) => void save({ ...globals, portsPolicy })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.sandbox.pineAccess}>
        <ControlRow label={d.sandbox.allWorkspaces} desc={d.sandbox.allWorkspacesDesc}>
          <Switch
            aria-label={d.sandbox.allWorkspaces}
            checked={globals.controls.allWorkspaces}
            onCheckedChange={(checked) =>
              void save({ ...globals, controls: { ...globals.controls, allWorkspaces: checked } })
            }
          />
        </ControlRow>
        <ControlRow label={d.sandbox.browser} desc={d.sandbox.browserDesc}>
          <BrowserSelect
            value={globals.controls.browser}
            onChange={(browser) =>
              void save({ ...globals, controls: { ...globals.controls, browser } })
            }
          />
        </ControlRow>
      </SettingsGroup>
    </div>
  )
}

export function BrowserSelect({
  value,
  onChange,
}: {
  value: SandboxGlobals['controls']['browser']
  onChange: (value: SandboxGlobals['controls']['browser']) => void
}): JSX.Element {
  const d = useDict()
  const label = value === 'allowlist' ? d.sandbox.browserAllowlist : d.sandbox.browserUnrestricted
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next === 'allowlist' || next === 'unrestricted') onChange(next)
      }}
    >
      <SelectTrigger aria-label={d.sandbox.browser} className="w-48">
        {label}
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="allowlist">{d.sandbox.browserAllowlist}</SelectItem>
        <SelectItem value="unrestricted">{d.sandbox.browserUnrestricted}</SelectItem>
      </SelectContent>
    </Select>
  )
}
