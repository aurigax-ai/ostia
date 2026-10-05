import {
  DEFAULT_PACKAGE_SETTINGS,
  DEFAULT_SWITCHES,
  type PackageSettings,
  type SandboxFixedPolicy,
  type SandboxGlobals,
  checkDomainPattern,
  parseSandboxGlobals,
} from '@shared/sandbox'
import { useEffect, useState } from 'react'
import { useDict } from '../i18n/useDict'
import { useSandboxStore } from '../stores/sandboxStore'
import { useSettingsStore } from '../stores/settingsStore'
import { PackagesEditor } from './SandboxPackagesTab'
import {
  SandboxFilesGroups,
  type SandboxListKey,
  SandboxNetworkGroups,
  type SandboxPolicyScope,
} from './SandboxPolicyGroups'
import { PortsPolicyRow } from './SandboxPortsTab'
import { ControlRow, SectionHead, SettingsGroup } from './SettingsPanel'
import { Select, SelectContent, SelectItem, SelectTrigger } from './ui/select'
import { Switch } from './ui/switch'

export function useSandboxGlobals(): SandboxGlobals {
  const raw = useSettingsStore((s) => s.sandbox)
  return parseSandboxGlobals(raw)
}

export const GLOBAL_LISTS: Record<SandboxListKey, keyof SandboxGlobals> = {
  allowRead: 'allowRead',
  allowWrite: 'allowWrite',
  denyRead: 'denyRead',
  denyWrite: 'denyWrite',
  allowSockets: 'allowSockets',
  domains: 'allowedDomains',
  deniedDomains: 'deniedDomains',
}

function isDomainList(key: SandboxListKey): key is 'domains' | 'deniedDomains' {
  return key === 'domains' || key === 'deniedDomains'
}

export function useFixedPolicy(
  workspaceId?: string,
  revision?: unknown,
): SandboxFixedPolicy | null {
  const [fixed, setFixed] = useState<SandboxFixedPolicy | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision refetches after an edit
  useEffect(() => {
    let live = true
    void window.ostia.sandbox.fixedPolicy(workspaceId).then((next) => {
      if (live) setFixed(next)
    })
    return () => {
      live = false
    }
  }, [workspaceId, revision])
  return fixed
}

export function SandboxSection(): JSX.Element {
  const d = useDict()
  const globals = useSandboxGlobals()
  const store = useSettingsStore((s) => s.setSandbox)
  const switches = { ...DEFAULT_SWITCHES, ...globals.switches }
  const fixed = useFixedPolicy(undefined, switches.gitConfig)

  const save = async (next: SandboxGlobals): Promise<void> => {
    await store(next)
    await useSandboxStore.getState().reloadAll()
  }

  const listOf = (key: SandboxListKey): string[] => (globals[GLOBAL_LISTS[key]] as string[]) ?? []

  const scope: SandboxPolicyScope = {
    items: listOf,
    inherited: () => [],
    setList: async (key, next) => {
      const added = next.filter((value) => !listOf(key).includes(value))
      const errors = isDomainList(key)
        ? added.flatMap((value) => {
            const check = checkDomainPattern(value)
            return check.ok ? [] : [{ value, reason: check.reason }]
          })
        : await window.ostia.sandbox.checkPaths(key, added)
      if (errors.length > 0) return { ok: false, errors }
      await save({ ...globals, [GLOBAL_LISTS[key]]: next })
      return { ok: true }
    },
    switches,
    setSwitch: (key, value) =>
      void save({ ...globals, switches: { ...switches, [key]: value ?? DEFAULT_SWITCHES[key] } }),
    fixed,
  }

  return (
    <div>
      <SectionHead title={d.sandbox.title} desc={d.sandbox.desc} />
      <SandboxNetworkGroups scope={scope} />
      <SandboxFilesGroups scope={scope} />
      <SettingsGroup title={d.sandbox.ports}>
        <PortsPolicyRow
          value={globals.portsPolicy ?? 'ask'}
          onChange={(portsPolicy) => void save({ ...globals, portsPolicy })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.sandbox.packages}>
        <PackagesEditor
          effective={globals.packages ?? DEFAULT_PACKAGE_SETTINGS}
          onChange={async (next) => {
            const base = globals.packages ?? DEFAULT_PACKAGE_SETTINGS
            await save({ ...globals, packages: { ...base, ...next } as PackageSettings })
          }}
        />
      </SettingsGroup>
      <SettingsGroup title={d.sandbox.ostiaAccess}>
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
      <SelectTrigger size="sm" aria-label={d.sandbox.browser} className="w-fit min-w-48 max-w-80">
        <span className="min-w-0 truncate">{label}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="allowlist">{d.sandbox.browserAllowlist}</SelectItem>
        <SelectItem value="unrestricted">{d.sandbox.browserUnrestricted}</SelectItem>
      </SelectContent>
    </Select>
  )
}
