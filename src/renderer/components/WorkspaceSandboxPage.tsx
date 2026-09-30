import {
  type DomainRefusal,
  type PortsPolicy,
  type SandboxControls,
  type WorkspaceSandbox,
  resolveSandbox,
} from '@shared/sandbox'
import { useCallback, useEffect, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { useSandboxStore } from '../stores/sandboxStore'
import { type ListEditResult, SandboxListEditor } from './SandboxListEditor'
import { PortsPolicyRow, SandboxPortsTab } from './SandboxPortsTab'
import { BrowserSelect, useSandboxGlobals } from './SandboxSection'
import { ControlRow, SectionHead } from './SettingsPanel'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Switch } from './ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'

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

function Refusals({ workspaceId }: { workspaceId: string }): JSX.Element {
  const d = useDict()
  const [list, setList] = useState<DomainRefusal[]>([])
  const load = useCallback(
    () => void window.pine.sandbox.refusals(workspaceId).then(setList),
    [workspaceId],
  )
  useEffect(() => {
    load()
  }, [load])
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })
  return (
    <fieldset aria-label={d.sandbox.refusals} className="mb-4">
      <h3 className="mb-2 font-medium text-fg text-ui-base">{d.sandbox.refusals}</h3>
      {list.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.sandbox.refusalsEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {list.map((r) => (
            <li key={r.host} className="flex items-center gap-2 text-ui-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-fg">{r.host}</span>
              <span className="text-fg-muted tabular-nums">
                {fmt(d.sandbox.refusalCount, { count: r.count, time: time.format(r.last) })}
              </span>
              <Button
                variant="outline"
                size="xs"
                onClick={() =>
                  void window.pine.sandbox.allowRefused(workspaceId, r.host).then(load)
                }
              >
                {d.sandbox.allow}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  )
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

  useEffect(() => {
    void window.pine.sandbox.get(workspaceId).then(setSettings)
  }, [workspaceId])

  const listResult = (res: Awaited<ReturnType<typeof window.pine.sandbox.setDomains>>) => {
    if (res.ok) setSettings(res.settings)
    return (res.ok ? { ok: true } : { ok: false, errors: res.errors }) as ListEditResult
  }

  const setControls = async (next: Partial<SandboxControls>): Promise<void> => {
    const updated = await window.pine.sandbox.setControls(workspaceId, next)
    if (updated) setSettings(updated)
  }

  const setPortsPolicy = async (policy: PortsPolicy | undefined): Promise<void> => {
    const updated = await window.pine.sandbox.setPortsPolicy(workspaceId, policy)
    if (updated) setSettings(updated)
  }

  const without = (key: keyof SandboxControls): Partial<SandboxControls> => {
    const { [key]: _gone, ...rest } = settings?.controls ?? {}
    return rest
  }

  const effective = resolveSandbox(
    globals,
    settings ?? { enabled: false, allowRead: [], domains: [], controls: {} },
  )
  const overrides = settings?.controls ?? {}

  return (
    <div>
      <SectionHead title={fmt(d.sandbox.workspacePage, { name: workspaceName })} />
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">{d.sandbox.general}</TabsTrigger>
          <TabsTrigger value="files">{d.sandbox.files}</TabsTrigger>
          <TabsTrigger value="network">{d.sandbox.network}</TabsTrigger>
          <TabsTrigger value="ports">{d.sandbox.ports}</TabsTrigger>
          <TabsTrigger value="access">{d.sandbox.pineAccess}</TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="pt-4">
          <ControlRow label={d.sandbox.enabled} desc={d.sandbox.enabledDesc}>
            <Switch
              aria-label={d.sandbox.enabled}
              checked={settings?.enabled ?? false}
              disabled={!settings}
              onCheckedChange={async (checked) => {
                await useSandboxStore.getState().setEnabled(workspaceId, checked)
                const next = await window.pine.sandbox.get(workspaceId)
                if (next) setSettings(next)
              }}
            />
          </ControlRow>
        </TabsContent>
        <TabsContent value="files" className="pt-4">
          <SandboxListEditor
            label={d.sandbox.readPaths}
            desc={d.sandbox.restartNote}
            items={settings?.allowRead ?? []}
            inherited={globals.allowRead}
            placeholder="~/notes"
            onChange={async (next) =>
              listResult(await window.pine.sandbox.setAllowRead(workspaceId, next))
            }
          />
        </TabsContent>
        <TabsContent value="network" className="pt-4">
          <SandboxListEditor
            label={d.sandbox.domains}
            desc={d.sandbox.domainsDesc}
            items={settings?.domains ?? []}
            inherited={globals.allowedDomains}
            placeholder="api.example.com"
            onChange={async (next) =>
              listResult(await window.pine.sandbox.setDomains(workspaceId, next))
            }
          />
          <Refusals workspaceId={workspaceId} />
        </TabsContent>
        <TabsContent value="ports" className="pt-4">
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
        </TabsContent>
        <TabsContent value="access" className="pt-4">
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
        </TabsContent>
      </Tabs>
    </div>
  )
}
