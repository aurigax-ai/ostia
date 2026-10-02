import type { PortsPolicy, SandboxPortRow } from '@shared/sandbox'
import { useCallback, useEffect, useState } from 'react'
import type { Dict } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { openBrowserAs } from '../lib/browserProfile'
import { isMac } from '../platform'
import { ControlRow } from './SettingsPanel'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from './ui/select'

const REFRESH_MS = 3000

export function PortsPolicySelect({
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
    () => void window.pine.sandbox.ports(workspaceId).then(setRows),
    [workspaceId],
  )
  useEffect(() => {
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [load])

  if (isMac) return <p className="text-fg-muted text-ui-sm">{d.sandbox.portsMac}</p>

  const expose = async (port: number): Promise<void> => {
    const res = await window.pine.sandbox.expose(workspaceId, port)
    setError(res.ok ? null : fmt(exposeFailure(d, res.error), { port, error: res.error }))
    load()
  }

  return (
    <fieldset aria-label={d.sandbox.ports} className="mb-4">
      {rows.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.sandbox.portsEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row.port} className="flex items-center gap-2 text-ui-sm">
              <span className="w-16 font-mono text-fg tabular-nums">:{row.port}</span>
              <span className="min-w-0 flex-1 truncate text-fg-muted">{row.process ?? ''}</span>
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
                      void window.pine.sandbox.unexpose(workspaceId, row.port).then(load)
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
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="mt-1 text-attn-fg text-ui-sm">
          {error}
        </p>
      ) : null}
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
