import type { Dict } from '@shared/app/dict'
import type {
  GatewayRelayState,
  GatewayRemoteStatus,
  GatewayRoute,
  GatewayTailnetState,
} from '@shared/gateway/gatewayApi'
import { DEFAULT_GATEWAY_ROUTE, LOOPBACK_ADDRESS } from '@shared/gateway/gatewayRoute'
import { useState } from 'react'
import { fmt, useDict } from '@/lib/app/useDict'

function tailnetProblem(d: Dict, node: GatewayTailnetState): string | null {
  if (node.state === 'running' && !node.ip) return d.settings.remoteTailnetNoIpv4
  if (node.state !== 'error') return null
  if (node.code === 'helper-stopped') return d.settings.remoteTailnetHelperStopped
  if (node.code === 'state-dir-unsafe') return d.settings.remoteTailnetStateDirUnsafe
  if (node.code === 'helper-unavailable') return d.settings.remoteTailnetUnavailable
  return fmt(d.settings.remoteTailnetError, { code: node.code })
}

export interface GatewayRouteState {
  running: boolean
  route: GatewayRoute
  exposed: boolean
  unreachable: boolean
  viaTailnet: boolean
  canPair: boolean
  problem: string | null
  signInError: string | null
  routeError: string | null
  onRoute: (next: Partial<GatewayRoute>) => Promise<void>
  onToggle: (checked: boolean) => Promise<void>
  onSignIn: () => Promise<void>
  onSignOut: () => Promise<void>
  onDiscoverable: (on: boolean) => Promise<void>
}

export function useGatewayRoute({
  status,
  tailnet,
  relay,
  refresh,
  clearPairing,
}: {
  status: GatewayRemoteStatus | null
  tailnet: GatewayTailnetState
  relay: GatewayRelayState
  refresh: () => Promise<void>
  clearPairing: () => void
}): GatewayRouteState {
  const d = useDict()
  const [routeError, setRouteError] = useState<string | null>(null)
  const [signInError, setSignInError] = useState<string | null>(null)

  const running = status?.running ?? false
  const route: GatewayRoute = status?.route ?? DEFAULT_GATEWAY_ROUTE
  const exposed = route.bindAddress !== LOOPBACK_ADDRESS
  const unreachable = !route.tailnet && !exposed && route.phoneAddress === null && !route.relay
  const viaTailnet = route.tailnet
  const directPair = viaTailnet
    ? tailnet.state === 'running' && tailnet.ip !== null
    : route.phoneAddress !== null || (exposed && status?.host === route.bindAddress)
  const canPair = running && (directPair || (route.relay && relay.state === 'listening'))
  const problem = viaTailnet ? tailnetProblem(d, tailnet) : null

  const onRoute = async (next: Partial<GatewayRoute>): Promise<void> => {
    setRouteError(null)
    await window.ostia.gateway.setRoute({ ...route, ...next })
    await refresh()
  }

  const onToggle = async (checked: boolean): Promise<void> => {
    setSignInError(null)
    setRouteError(null)
    if (checked) {
      const result = await window.ostia.gateway.enable()
      if ('error' in result) {
        setRouteError(fmt(d.settings.remoteAddressUnavailable, { address: route.bindAddress }))
      }
    } else {
      await window.ostia.gateway.disable()
      clearPairing()
    }
    await refresh()
  }

  const onSignIn = async (): Promise<void> => {
    const result = await window.ostia.gateway.tailnetSignIn()
    setSignInError(
      !result.ok && result.error === 'login-link-refused'
        ? d.settings.remoteTailnetLoginRefused
        : null,
    )
  }

  const onSignOut = async (): Promise<void> => {
    await window.ostia.gateway.tailnetSignOut()
    clearPairing()
    await refresh()
  }

  const onDiscoverable = async (on: boolean): Promise<void> => {
    await window.ostia.gateway.setDiscoverable(on)
    await refresh()
  }

  return {
    running,
    route,
    exposed,
    unreachable,
    viaTailnet,
    canPair,
    problem,
    signInError,
    routeError,
    onRoute,
    onToggle,
    onSignIn,
    onSignOut,
    onDiscoverable,
  }
}
