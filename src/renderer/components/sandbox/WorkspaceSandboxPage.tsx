import { SectionTab, SectionTabsList } from '@/components/common/SectionTabs'
import { ControlRow, SectionHead, SettingsGroup } from '@/components/settings/SettingsPanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { fmt, useDict } from '@/i18n/useDict'
import { isMac } from '@/platform'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import {
  DEFAULT_PACKAGE_SETTINGS,
  type PortsPolicy,
  type SandboxControls,
  type WorkspaceSandbox,
  resolvePackages,
  resolveSandbox,
} from '@shared/sandbox/sandbox'
import { useEffect, useState } from 'react'
import { PackagesEditor } from './SandboxPackagesTab'
import {
  SandboxFilesGroups,
  type SandboxListKey,
  SandboxNetworkGroups,
  type SandboxPolicyScope,
} from './SandboxPolicyGroups'
import { PortsPolicyRow, SandboxPortsTab } from './SandboxPortsTab'
import { SandboxSecretsTab } from './SandboxSecretsTab'
import { BrowserSelect, GLOBAL_LISTS, useFixedPolicy, useSandboxGlobals } from './SandboxSection'
import { SandboxViolations } from './SandboxViolations'

const EMPTY: WorkspaceSandbox = { enabled: false, allowRead: [], domains: [], controls: {} }

function OverrideBadge({
  overridden,
  onReset,
}: {
  overridden: boolean
  onReset: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <>
      <Badge variant="outline">{overridden ? d.sandbox.overridden : d.sandbox.inherited}</Badge>
      {overridden ? (
        <Button variant="ghost" size="xs" onClick={onReset}>
          {d.sandbox.reset}
        </Button>
      ) : null}
    </>
  )
}

const WORKSPACE_LISTS: Record<SandboxListKey, keyof WorkspaceSandbox> = {
  allowRead: 'allowRead',
  allowWrite: 'allowWrite',
  denyRead: 'denyRead',
  denyWrite: 'denyWrite',
  allowSockets: 'allowSockets',
  domains: 'domains',
  deniedDomains: 'deniedDomains',
}

export function WorkspaceSandboxPage({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string
  workspaceName: string
}): JSX.Element {
  const d = useDict()
  const globals = useSandboxGlobals()
  const [settings, setSettings] = useState<WorkspaceSandbox | null>(null)
  const fixed = useFixedPolicy(workspaceId, settings)

  useEffect(() => {
    void window.ostia.sandbox.get(workspaceId).then(setSettings)
  }, [workspaceId])

  const applied = (next: WorkspaceSandbox | null): void => {
    if (!next) return
    setSettings(next)
    void useSandboxStore.getState().load(workspaceId)
  }

  const setControls = async (next: Partial<SandboxControls>): Promise<void> =>
    applied(await window.ostia.sandbox.setControls(workspaceId, next))

  const setPortsPolicy = async (policy: PortsPolicy | undefined): Promise<void> =>
    applied(await window.ostia.sandbox.setPortsPolicy(workspaceId, policy))

  const without = (key: keyof SandboxControls): Partial<SandboxControls> => {
    const { [key]: _gone, ...rest } = settings?.controls ?? {}
    return rest
  }

  const current = settings ?? EMPTY
  const effective = resolveSandbox(globals, current)
  const overrides = current.controls

  const scope: SandboxPolicyScope = {
    items: (key) => (current[WORKSPACE_LISTS[key]] as string[] | undefined) ?? [],
    inherited: (key) => (globals[GLOBAL_LISTS[key]] as string[] | undefined) ?? [],
    setList: async (key, next) => {
      const res =
        key === 'domains'
          ? await window.ostia.sandbox.setDomains(workspaceId, next)
          : key === 'deniedDomains'
            ? await window.ostia.sandbox.setDeniedDomains(workspaceId, next)
            : await window.ostia.sandbox.setPaths(workspaceId, key, next)
      if (!res.ok) return { ok: false, errors: res.errors }
      applied(res.settings)
      return { ok: true }
    },
    switches: effective.switches,
    overridden: current.switches ?? {},
    setSwitch: (key, value) => {
      const { [key]: _gone, ...rest } = current.switches ?? {}
      const next = value === undefined ? rest : { ...rest, [key]: value }
      void window.ostia.sandbox.setSwitches(workspaceId, next).then(applied)
    },
    fixed,
  }

  return (
    <div>
      <SectionHead
        title={fmt(d.sandbox.workspacePage, { name: workspaceName })}
        desc={d.sandbox.workspaceDesc}
      />
      <Tabs defaultValue="general">
        <SectionTabsList>
          <SectionTab value="general">{d.sandbox.general}</SectionTab>
          <SectionTab value="files">{d.sandbox.files}</SectionTab>
          <SectionTab value="network">{d.sandbox.network}</SectionTab>
          <SectionTab value="ports">{d.sandbox.ports}</SectionTab>
          <SectionTab value="secrets">{d.sandbox.secrets}</SectionTab>
          <SectionTab value="packages">{d.sandbox.packages}</SectionTab>
          <SectionTab value="access">{d.sandbox.ostiaAccess}</SectionTab>
          <SectionTab value="violations">{d.sandbox.violations}</SectionTab>
        </SectionTabsList>
        <TabsContent value="general">
          <SettingsGroup title={d.sandbox.title}>
            <ControlRow label={d.sandbox.enabled} desc={d.sandbox.enabledDesc}>
              <Switch
                aria-label={d.sandbox.enabled}
                checked={settings?.enabled ?? false}
                disabled={!settings}
                onCheckedChange={async (checked) => {
                  await useSandboxStore.getState().setEnabled(workspaceId, checked)
                  const next = await window.ostia.sandbox.get(workspaceId)
                  if (next) setSettings(next)
                }}
              />
            </ControlRow>
          </SettingsGroup>
        </TabsContent>
        <TabsContent value="files">
          <SandboxFilesGroups scope={scope} />
        </TabsContent>
        <TabsContent value="network">
          <SandboxNetworkGroups scope={scope} />
        </TabsContent>
        <TabsContent value="ports">
          <SettingsGroup title={d.sandbox.ports} desc={isMac ? undefined : d.sandbox.portsDesc}>
            <fieldset aria-label={d.sandbox.portsPolicy}>
              <PortsPolicyRow
                value={effective.portsPolicy}
                overridden={settings?.ports !== undefined}
                badge={
                  <OverrideBadge
                    overridden={settings?.ports !== undefined}
                    onReset={() => void setPortsPolicy(undefined)}
                  />
                }
                onChange={(policy) => void setPortsPolicy(policy)}
              />
            </fieldset>
            <SandboxPortsTab workspaceId={workspaceId} />
          </SettingsGroup>
        </TabsContent>
        <TabsContent value="secrets">
          <SettingsGroup title={d.sandbox.secrets} desc={d.sandbox.secretsDesc}>
            <SandboxSecretsTab workspaceId={workspaceId} />
          </SettingsGroup>
        </TabsContent>
        <TabsContent value="packages">
          <SettingsGroup title={d.sandbox.packages}>
            <PackagesEditor
              effective={resolvePackages(globals, current)}
              own={current.packages ?? {}}
              inheritedDeny={(globals.packages ?? DEFAULT_PACKAGE_SETTINGS).denyList}
              onChange={async (next) =>
                applied(await window.ostia.sandbox.setPackages(workspaceId, next))
              }
            />
          </SettingsGroup>
        </TabsContent>
        <TabsContent value="access">
          <SettingsGroup title={d.sandbox.ostiaAccess}>
            <fieldset aria-label={d.sandbox.allWorkspaces}>
              <ControlRow label={d.sandbox.allWorkspaces} desc={d.sandbox.allWorkspacesDesc}>
                <OverrideBadge
                  overridden={overrides.allWorkspaces !== undefined}
                  onReset={() => void setControls(without('allWorkspaces'))}
                />
                <Switch
                  aria-label={d.sandbox.allWorkspaces}
                  checked={effective.controls.allWorkspaces}
                  onCheckedChange={(checked) =>
                    void setControls({ ...overrides, allWorkspaces: checked })
                  }
                />
              </ControlRow>
            </fieldset>
            <fieldset aria-label={d.sandbox.browser}>
              <ControlRow label={d.sandbox.browser} desc={d.sandbox.browserDesc}>
                <OverrideBadge
                  overridden={overrides.browser !== undefined}
                  onReset={() => void setControls(without('browser'))}
                />
                <BrowserSelect
                  value={effective.controls.browser}
                  onChange={(browser) => void setControls({ ...overrides, browser })}
                />
              </ControlRow>
            </fieldset>
          </SettingsGroup>
        </TabsContent>
        <TabsContent value="violations">
          <SandboxViolations workspaceId={workspaceId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
