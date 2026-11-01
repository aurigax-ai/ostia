import type { Dict } from '@shared/app/dict'
import type {
  GatewayBindAddress,
  GatewayPhoneAddress,
  GatewayRelayState,
  GatewayRoute,
  GatewayTailnetState,
} from '@shared/gateway/gatewayApi'
import { formatPhoneAddress, parsePhoneAddress } from '@shared/gateway/gatewayRoute'
import { type JSX, useState } from 'react'
import { Notice } from '@/components/common/Notice'
import { SignInNotice } from '@/components/server/SignInNotice'
import { useServerStatus } from '@/components/server/useServerStatus'
import { CommitInput } from '@/components/settingsKit/CommitInput'
import { ControlRow, ToggleRow } from '@/components/settingsKit/ControlRow'
import { SelectField } from '@/components/settingsKit/SelectField'
import { StatusText } from '@/components/settingsKit/StatusText'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { useUIStore } from '@/stores/app/uiStore'
import type { GatewayMethod, GatewayRouteState } from './useGatewayRoute'
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

function methodName(d: Dict, method: GatewayMethod): string {
  if (method === 'relay') return d.settings.remoteMethodRelay
  return method === 'tailscale' ? d.settings.remoteMethodTailscale : d.settings.remoteMethodNetwork
}

const openAccount = (): void => useUIStore.getState().openSettings('sync')

function relayStatusText(d: Dict, relay: GatewayRelayState): string {
  if (relay.state === 'listening') return d.settings.remoteRelayConnected
  if (relay.state === 'error') return fmt(d.settings.remoteRelayError, { code: relay.code })
  if (relay.state === 'connecting') return d.settings.remoteRelayConnecting
  return d.settings.remoteStateOff
}

function RelayRows({ relay }: { relay: GatewayRelayState }): JSX.Element {
  const d = useDict()
  const server = useServerStatus()
  if (!server.signedIn) {
    return <SignInNotice text={d.settings.remoteRelaySignedOut} />
  }
  return (
    <ControlRow
      label={d.settings.remoteRelayServer}
      desc={fmt(d.settings.remoteRelayDesc, { server: server.host ?? '' })}
      below={<StatusText text={relayStatusText(d, relay)} ok={relay.state === 'listening'} />}
    >
      <Button variant="outline" size="sm" onClick={openAccount}>
        {d.settings.remoteRelayManage}
      </Button>
    </ControlRow>
  )
}

function TailscaleRows({
  tailnet,
  running,
  onSignIn,
  onSignOut,
}: {
  tailnet: GatewayTailnetState
  running: boolean
  onSignIn: () => Promise<void>
  onSignOut: () => Promise<void>
}): JSX.Element {
  const d = useDict()
  return (
    <ControlRow
      label={d.settings.remoteTailscale}
      desc={d.settings.remoteTailscaleDesc}
      below={<StatusText text={tailnetSummary(d, tailnet)} ok={tailnet.state === 'running'} />}
    >
      {running && tailnet.state === 'needs-login' ? (
        <Button variant="outline" size="sm" onClick={() => void onSignIn()}>
          {d.settings.remoteTailnetSignIn}
        </Button>
      ) : null}
      {tailnet.state === 'running' ? (
        <Button variant="outline" size="sm" onClick={() => void onSignOut()}>
          {d.settings.remoteTailnetSignOut}
        </Button>
      ) : null}
    </ControlRow>
  )
}

function NetworkRows({
  gateway,
  routing,
}: {
  gateway: GatewayStatus
  routing: GatewayRouteState
}): JSX.Element {
  const d = useDict()
  const { status, addresses } = gateway
  const { running, route, exposed, unreachable, onRoute, onDiscoverable } = routing
  return (
    <>
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
      <PhoneAddressRow
        route={route}
        disabled={running}
        onSave={(phoneAddress) => onRoute({ phoneAddress })}
      />
      <ToggleRow
        label={d.settings.remoteDiscoverable}
        desc={d.settings.remoteDiscoverableDesc}
        checked={status?.discoverable ?? false}
        onChange={(v) => void onDiscoverable(v)}
      />
      {unreachable ? <Notice>{d.settings.remoteLoopbackOnly}</Notice> : null}
      {exposed ? (
        <Notice>{fmt(d.settings.remoteAddressWarning, { address: route.bindAddress })}</Notice>
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
  const server = useServerStatus()
  const { tailnet, relay } = gateway
  const { running, method, problem, signInError, routeError, onToggle, onMethod } = routing
  const blocked = !running && method === 'relay' && !server.signedIn
  return (
    <>
      <ToggleRow
        label={d.settings.remoteEnable}
        desc={d.settings.remoteEnableDesc}
        checked={running}
        disabled={blocked}
        onChange={(v) => void onToggle(v)}
        below={
          <StatusText
            text={
              running
                ? fmt(d.settings.remoteRunning, { method: methodName(d, method) })
                : d.settings.remoteStateOff
            }
            ok={running}
          />
        }
      />
      <ControlRow label={d.settings.remoteMethod} desc={d.settings.remoteMethodDesc}>
        <SelectField<GatewayMethod>
          value={method}
          onChange={(next) => void onMethod(next)}
          options={(['relay', 'tailscale', 'network'] as const).map((value) => ({
            value,
            label: methodName(d, value),
          }))}
          label={d.settings.remoteMethod}
          width="w-56"
          disabled={running}
        />
      </ControlRow>
      {method === 'relay' ? <RelayRows relay={relay} /> : null}
      {method === 'tailscale' ? (
        <TailscaleRows
          tailnet={tailnet}
          running={running}
          onSignIn={routing.onSignIn}
          onSignOut={routing.onSignOut}
        />
      ) : null}
      {method === 'network' ? <NetworkRows gateway={gateway} routing={routing} /> : null}
      {problem ? <Notice>{problem}</Notice> : null}
      {signInError ? <Notice>{signInError}</Notice> : null}
      {routeError ? <Notice>{routeError}</Notice> : null}
    </>
  )
}
