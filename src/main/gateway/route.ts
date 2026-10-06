import type { GatewayRoute } from '../../shared/types'
import { loadJson, saveJson, storePath } from '../jsonStore'

const TAILNET_ROUTE: GatewayRoute = { kind: 'tailnet' }
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

function routePath(): string {
  return storePath('gateway-config', 'global')
}

export function parseRoute(value: unknown): GatewayRoute | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as { kind?: unknown; address?: unknown }
  if (v.kind === 'tailnet') return TAILNET_ROUTE
  if (v.kind === 'address' && typeof v.address === 'string' && IPV4.test(v.address)) {
    return { kind: 'address', address: v.address }
  }
  return null
}

export function loadRoute(): GatewayRoute {
  return parseRoute(loadJson<{ route?: unknown }>(routePath(), {}).route) ?? TAILNET_ROUTE
}

export function saveRoute(route: GatewayRoute): void {
  saveJson(routePath(), { route })
}
