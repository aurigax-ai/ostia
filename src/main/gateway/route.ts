import { DEFAULT_GATEWAY_ROUTE, isBindAddress, phoneAddressOf } from '../../shared/gatewayRoute'
import type { GatewayRoute } from '../../shared/types'
import { loadJson, saveJson, storePath } from '../jsonStore'

function routePath(): string {
  return storePath('gateway-config', 'global')
}

type RouteProblem = 'unknown-address' | 'invalid-phone-address'

export function checkRoute(value: unknown): GatewayRoute | RouteProblem {
  if (typeof value !== 'object' || value === null) return 'unknown-address'
  const v = value as { bindAddress?: unknown; tailnet?: unknown; phoneAddress?: unknown }
  if (!isBindAddress(v.bindAddress) || typeof v.tailnet !== 'boolean') return 'unknown-address'
  const phoneAddress = v.phoneAddress === null ? null : phoneAddressOf(v.phoneAddress)
  if (v.phoneAddress !== null && !phoneAddress) return 'invalid-phone-address'
  return { bindAddress: v.bindAddress, tailnet: v.tailnet, phoneAddress }
}

interface GatewayConfig {
  route?: unknown
  discoverable?: unknown
}

function loadConfig(): GatewayConfig {
  return loadJson<GatewayConfig>(routePath(), {})
}

export function loadRoute(): GatewayRoute {
  const route = checkRoute(loadConfig().route)
  return typeof route === 'string' ? DEFAULT_GATEWAY_ROUTE : route
}

export function saveRoute(route: GatewayRoute): void {
  saveJson(routePath(), { ...loadConfig(), route })
}

export function loadDiscoverable(): boolean {
  return loadConfig().discoverable === true
}

export function saveDiscoverable(discoverable: boolean): void {
  saveJson(routePath(), { ...loadConfig(), discoverable })
}
