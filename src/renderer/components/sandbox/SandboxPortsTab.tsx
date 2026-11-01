import type { Dict } from '@shared/app/dict'
import type { PortsPolicy, SandboxPortRow } from '@shared/sandbox/sandbox'
import { type JSX, useCallback, useEffect, useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { fmt, useDict } from '@/lib/app/useDict'
import { openBrowserAs } from '@/lib/browser/browserProfile'
import { isMac } from '@/platform'

const REFRESH_MS = 3000

function PortsPolicySelect({
  value,
  onChange,
}: {
  value: PortsPolicy
  onChange: (value: PortsPolicy) => void
}): JSX.Element {
  const d = useDict()
  const labels: Record<PortsPolicy, string> = {
    ask: d.sandbox.portsAsk,
    allow: d.sandbox.portsAllow,
    deny: d.sandbox.portsDeny,
  }
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next === 'ask' || next === 'allow' || next === 'deny') onChange(next)
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={d.sandbox.portsPolicy}
        className="w-fit min-w-40 max-w-80"
      >
        <span className="min-w-0 truncate">{labels[value]}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="ask">{labels.ask}</SelectItem>
        <SelectItem value="allow">{labels.allow}</SelectItem>
        <SelectItem value="deny">{labels.deny}</SelectItem>
      </SelectContent>
    </Select>
  )
}

function exposeFailure(d: Dict, error: string): string {
  return error === 'unix-sockets-off' ? d.sandbox.exposeNeedsUnixSockets : d.sandbox.exposeFailed
}

export function SandboxPortsTab({ workspaceId }: { workspaceId: string }): JSX.Element {
  const d = useDict()
  const [rows, setRows] = useState<SandboxPortRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(
    () => void window.ostia.sandbox.ports(workspaceId).then(setRows),
    [workspaceId],
  )
  useEffect(() => {
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [load])

  if (isMac) return <p className="text-fg-muted text-ui-sm">{d.sandbox.portsMac}</p>

  const expose = async (port: number): Promise<void> => {
    const res = await window.ostia.sandbox.expose(workspaceId, port)
    setError(res.ok ? null : fmt(exposeFailure(d, res.error), { port, error: res.error }))
    load()
  }

  return (
    <fieldset aria-label={d.sandbox.ports} className="mb-4">
      <SettingsList label={d.sandbox.ports} empty={d.sandbox.portsEmpty}>
        {rows.map((row) => (
          <SettingsListRow
            key={row.port}
            title={<span className="font-mono tabular-nums">:{row.port}</span>}
            meta={row.process ?? null}
            actions={
              <>
                {row.exposed ? <Badge variant="outline">{d.sandbox.exposed}</Badge> : null}
                {row.exposed ? (
                  <>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() =>
                        openBrowserAs(workspaceId, `http://127.0.0.1:${row.port}/`, 'human')
                      }
                    >
                      {d.sandbox.open}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        void window.ostia.sandbox.unexpose(workspaceId, row.port).then(load)
                      }
                    >
                      {d.sandbox.unexpose}
                    </Button>
                  </>
                ) : (
                  <Button variant="outline" size="xs" onClick={() => void expose(row.port)}>
                    {d.sandbox.expose}
                  </Button>
                )}
              </>
            }
          />
        ))}
      </SettingsList>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </fieldset>
  )
}

export function PortsPolicyRow({
  value,
  overridden,
  badge,
  onChange,
}: {
  value: PortsPolicy
  overridden?: boolean
  badge?: JSX.Element
  onChange: (value: PortsPolicy) => void
}): JSX.Element {
  const d = useDict()
  return (
    <ControlRow label={d.sandbox.portsPolicy}>
      {overridden !== undefined ? badge : null}
      <PortsPolicySelect value={value} onChange={onChange} />
    </ControlRow>
  )
}
