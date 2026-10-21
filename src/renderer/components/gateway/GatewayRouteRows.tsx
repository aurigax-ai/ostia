import type { Dict } from '@shared/app/dict'
import type {
  GatewayBindAddress,
  GatewayPhoneAddress,
  GatewayRelayState,
  GatewayRoute,
  GatewayTailnetState,
} from '@shared/gateway/gatewayApi'
import { formatPhoneAddress, parsePhoneAddress } from '@shared/gateway/gatewayRoute'
import { useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { useServerStatus } from '@/components/server/useServerStatus'
import { CommitInput } from '@/components/settingsKit/CommitInput'
import { ControlRow, ToggleRow } from '@/components/settingsKit/ControlRow'
import { SelectField } from '@/components/settingsKit/SelectField'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { useUIStore } from '@/stores/app/uiStore'
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
  const [invalid, setInvalid] = useState(false)

  const commit = (text: string): boolean => {
    const trimmed = text.trim()
    const phoneAddress = trimmed === '' ? null : parsePhoneAddress(trimmed)
    const accepted = trimmed === '' || phoneAddress !== null
    setInvalid(!accepted)
    if (accepted && trimmed !== saved) void onSave(phoneAddress)
    return accepted
  }

  return (
    <ControlRow
      label={d.settings.remotePhoneAddress}
      desc={d.settings.remotePhoneAddressDesc}
      error={invalid ? d.settings.remotePhoneAddressInvalid : null}
      errorId="remote-phone-address-error"
    >
      <CommitInput
        value={saved}
        spellCheck={false}
        placeholder={d.settings.remotePhoneAddressPlaceholder}
        disabled={disabled}
        aria-label={d.settings.remotePhoneAddress}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? 'remote-phone-address-error' : undefined}
        onCommit={commit}
        onCancel={() => setInvalid(false)}
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

function RelayRows({
  route,
  relay,
  running,
  onRoute,
}: {
  route: GatewayRoute
  relay: GatewayRelayState
  running: boolean
  onRoute: (next: Partial<GatewayRoute>) => Promise<void>
}): JSX.Element {
  const d = useDict()
  const server = useServerStatus()
  return (
    <>
      <ToggleRow
        label={d.settings.remoteRelay}
        desc={
          server.host
            ? fmt(d.settings.remoteRelayDesc, { server: server.host })
            : d.settings.remoteRelayDescNoServer
        }
        checked={route.relay}
        onChange={(v) => void onRoute({ relay: v })}
        disabled={running}
      />
      {route.relay && relay.state === 'needs-sign-in' ? (
        <Notice
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => useUIStore.getState().openSettings('server')}
            >
              {d.settings.remoteRelayOpenServer}
            </Button>
          }
        >
          {d.settings.remoteRelayNeedsSignIn}
        </Notice>
      ) : null}
      {route.relay && relay.state === 'error' ? (
        <Notice>{fmt(d.settings.remoteRelayError, { code: relay.code })}</Notice>
      ) : null}
    </>
  )
}

export function GatewayRouteRows({
  gateway,
  routing,
}: {
  gateway: GatewayStatus
  routing: GatewayRouteState
}): JSX.Element {
  const d = useDict()
  const { status, tailnet, relay, addresses } = gateway
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

      <RelayRows route={route} relay={relay} running={running} onRoute={onRoute} />

      {unreachable ? <Notice>{d.settings.remoteLoopbackOnly}</Notice> : null}

      {exposed ? (
        <>
          <Notice>{fmt(d.settings.remoteAddressWarning, { address: route.bindAddress })}</Notice>
          <Notice tone="info">{d.settings.remoteLanOnlyInfo}</Notice>
        </>
      ) : null}

      <ToggleRow
        label={d.settings.remoteDiscoverable}
        desc={d.settings.remoteDiscoverableDesc}
        checked={status?.discoverable ?? false}
        onChange={(v) => void onDiscoverable(v)}
      />

      {problem ? <Notice>{problem}</Notice> : null}
      {signInError ? <Notice>{signInError}</Notice> : null}
      {routeError ? <Notice>{routeError}</Notice> : null}
    </>
  )
}
