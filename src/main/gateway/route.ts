import { randomInt } from 'node:crypto'
import { FRIENDLY_NAME, friendlyNameFrom } from '../../shared/gateway/friendlyName'
import type { GatewayRoute } from '../../shared/gateway/gatewayApi'
import {
  DEFAULT_GATEWAY_ROUTE,
  isBindAddress,
  isBindInterface,
  LOOPBACK_ADDRESS,
  phoneAddressOf,
} from '../../shared/gateway/gatewayRoute'
import { loadJson, saveJson, storePath } from '../platform/jsonStore'

function routePath(): string {
  return storePath('gateway-config', 'global')
}

type RouteProblem = 'unknown-address' | 'invalid-phone-address' | 'two-methods'

export function checkRoute(value: unknown): GatewayRoute | RouteProblem {
  if (typeof value !== 'object' || value === null) return 'unknown-address'
  const v = value as {
    bindAddress?: unknown
    bindInterface?: unknown
    tailnet?: unknown
    phoneAddress?: unknown
    relay?: unknown
  }
  if (!isBindAddress(v.bindAddress) || typeof v.tailnet !== 'boolean') return 'unknown-address'
  if (typeof v.relay !== 'boolean') return 'unknown-address'
  if (
    !isBindInterface(v.bindInterface) ||
    (v.bindAddress === LOOPBACK_ADDRESS) !== (v.bindInterface === null)
  ) {
    return 'unknown-address'
  }
  const phoneAddress = v.phoneAddress === null ? null : phoneAddressOf(v.phoneAddress)
  if (v.phoneAddress !== null && !phoneAddress) return 'invalid-phone-address'
  const direct = v.bindInterface !== null || phoneAddress !== null
  if ([v.relay, v.tailnet, direct].filter(Boolean).length > 1) return 'two-methods'
  return {
    bindAddress: v.bindAddress,
    bindInterface: v.bindInterface,
    tailnet: v.tailnet,
    phoneAddress,
    relay: v.relay,
  }
}

interface GatewayConfig {
  route?: unknown
  discoverable?: unknown
  phoneWorkspace?: unknown
  friendlyName?: unknown
}

function loadConfig(): GatewayConfig {
  return loadJson<GatewayConfig>(routePath(), {})
}

export function loadPhoneWorkspaceRecord(): unknown {
  return loadConfig().phoneWorkspace
}

export function savePhoneWorkspaceRecord(phoneWorkspace: unknown): void {
  saveJson(routePath(), { ...loadConfig(), phoneWorkspace })
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

export function friendlyName(): string {
  const config = loadConfig()
  if (typeof config.friendlyName === 'string' && FRIENDLY_NAME.test(config.friendlyName)) {
    return config.friendlyName
  }
  const fresh = friendlyNameFrom((count) => randomInt(count))
  saveJson(routePath(), { ...config, friendlyName: fresh })
  return fresh
}
