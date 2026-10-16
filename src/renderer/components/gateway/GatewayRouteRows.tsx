import { ControlRow, ToggleRow, WarningNote } from '@/components/settingsKit/ControlRow'
import { SelectField } from '@/components/settingsKit/SelectField'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fmt, useDict } from '@/lib/app/useDict'
import type { Dict } from '@shared/app/dict'
import type {
  GatewayBindAddress,
  GatewayPhoneAddress,
  GatewayRoute,
  GatewayTailnetState,
} from '@shared/gateway/gatewayApi'
import { formatPhoneAddress, parsePhoneAddress } from '@shared/gateway/gatewayRoute'
import { useEffect, useState } from 'react'
import type { GatewayRouteState } from './useGatewayRoute'
import type { GatewayStatus } from './useGatewayStatus'

function bindOptions(
  d: Dict,
  addresses: GatewayBindAddress[],
  bindAddress: string,
): { value: string; label: string }[] {
  const options = addresses.map((a) => ({
    value: a.address,
    label: a.loopback
      ? fmt(d.settings.remoteBindLoopback, { address: a.address })
      : fmt(d.settings.remoteRouteAddress, { iface: a.iface, address: a.address }),
  }))
  if (!addresses.some((a) => a.address === bindAddress)) {
    options.push({
      value: bindAddress,
      label: fmt(d.settings.remoteRouteMissing, { address: bindAddress }),
    })
  }
  return options
}

function PhoneAddressRow({
  route,
  disabled,
  onSave,
}: {
  route: GatewayRoute
  disabled: boolean
  onSave: (phoneAddress: GatewayPhoneAddress | null) => Promise<void>
}): JSX.Element {
  const d = useDict()
  const saved = route.phoneAddress ? formatPhoneAddress(route.phoneAddress) : ''
  const [text, setText] = useState(saved)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => setText(saved), [saved])

  const commit = (): void => {
    const trimmed = text.trim()
    if (trimmed === saved) {
      setInvalid(false)
      return
    }
    const phoneAddress = trimmed === '' ? null : parsePhoneAddress(trimmed)
    if (trimmed !== '' && !phoneAddress) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    void onSave(phoneAddress)
  }

  return (
    <ControlRow
      label={d.settings.remotePhoneAddress}
      desc={d.settings.remotePhoneAddressDesc}
      error={invalid ? d.settings.remotePhoneAddressInvalid : null}
      errorId="remote-phone-address-error"
    >
      <Input
        value={text}
        spellCheck={false}
        placeholder={d.settings.remotePhoneAddressPlaceholder}
        disabled={disabled}
        aria-label={d.settings.remotePhoneAddress}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? 'remote-phone-address-error' : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        className="h-7 w-56 font-mono"
      />
    </ControlRow>
  )
}

function tailnetSummary(d: Dict, node: GatewayTailnetState): string {
  if (node.state === 'starting') return d.settings.remoteTailnetStarting
  if (node.state === 'needs-login') return d.settings.remoteTailnetNeedsLogin
  if (node.state === 'running') {
    return fmt(d.settings.remoteTailnetRunning, { name: node.dnsName ?? '', ip: node.ip ?? '' })
  }
  return d.settings.remoteTailnetOff
}

export function GatewayRouteRows({
  gateway,
  routing,
}: {
  gateway: GatewayStatus
  routing: GatewayRouteState
}): JSX.Element {
  const d = useDict()
  const { status, tailnet, addresses } = gateway
  const {
    running,
    route,
    exposed,
    unreachable,
    viaTailnet,
    problem,
    signInError,
    routeError,
    onRoute,
    onToggle,
    onSignIn,
    onSignOut,
    onDiscoverable,
  } = routing
  return (
    <>
      <ToggleRow
        label={d.settings.remoteEnable}
        desc={d.settings.remoteEnableDesc}
        checked={running}
        onChange={(v) => void onToggle(v)}
      />

      <ControlRow label={d.settings.remoteBind} desc={d.settings.remoteBindDesc}>
        <SelectField
          value={route.bindAddress}
          onChange={(v) => void onRoute({ bindAddress: v })}
          options={bindOptions(d, addresses, route.bindAddress)}
          label={d.settings.remoteBind}
          width="w-fit min-w-64 max-w-80"
          disabled={running}
        />
      </ControlRow>

      <ToggleRow
        label={d.settings.remoteTailnetNode}
        desc={d.settings.remoteTailnetNodeDesc}
        checked={route.tailnet}
        onChange={(v) => void onRoute({ tailnet: v })}
        disabled={running}
      />

      {viaTailnet ? (
        <ControlRow
          label={d.settings.remoteTailscale}
          desc={d.settings.remoteTailscaleDesc}
          below={
            <span className="flex min-w-0 items-center gap-2 text-fg-muted text-ui-sm">
              <span className={`dot ${tailnet.state === 'running' ? 'done' : ''}`} />
              <span className="min-w-0 truncate">{tailnetSummary(d, tailnet)}</span>
              {running && tailnet.state === 'needs-login' ? (
                <Button variant="outline" size="sm" onClick={() => void onSignIn()}>
                  {d.settings.remoteTailnetSignIn}
                </Button>
              ) : null}
              {tailnet.state === 'running' ? (
                <Button variant="ghost" size="sm" onClick={() => void onSignOut()}>
                  {d.settings.remoteTailnetSignOut}
                </Button>
              ) : null}
            </span>
          }
        />
      ) : (
        <PhoneAddressRow
          route={route}
          disabled={running}
          onSave={(phoneAddress) => onRoute({ phoneAddress })}
        />
      )}

      {unreachable ? <WarningNote>{d.settings.remoteLoopbackOnly}</WarningNote> : null}

      {exposed ? (
        <WarningNote>
          {fmt(d.settings.remoteAddressWarning, { address: route.bindAddress })}
        </WarningNote>
      ) : null}

      <ToggleRow
        label={d.settings.remoteDiscoverable}
        desc={d.settings.remoteDiscoverableDesc}
        checked={status?.discoverable ?? false}
        onChange={(v) => void onDiscoverable(v)}
      />

      {problem ? <WarningNote>{problem}</WarningNote> : null}
      {signInError ? <WarningNote>{signInError}</WarningNote> : null}
      {routeError ? <WarningNote>{routeError}</WarningNote> : null}
    </>
  )
}
