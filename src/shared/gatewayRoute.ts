import type { GatewayPhoneAddress, GatewayRoute } from './types'

export const LOOPBACK_ADDRESS = '127.0.0.1'

export const DEFAULT_GATEWAY_ROUTE: GatewayRoute = {
  bindAddress: LOOPBACK_ADDRESS,
  tailnet: true,
  phoneAddress: null,
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i
const PORT = /^[1-9]\d{0,4}$/
const MAX_PORT = 65_535
const MAX_HOST_LENGTH = 253

export function isBindAddress(value: unknown): value is string {
  return typeof value === 'string' && IPV4.test(value) && value !== '0.0.0.0'
}

function isPhoneHost(host: string): boolean {
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) return false
  if (/^[\d.]+$/.test(host)) return IPV4.test(host)
  return host.split('.').every((label) => HOST_LABEL.test(label))
}

function isPort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) >= 1 && (port as number) <= MAX_PORT
}

export function phoneAddressOf(value: unknown): GatewayPhoneAddress | null {
  if (typeof value !== 'object' || value === null) return null
  const { host, port } = value as { host?: unknown; port?: unknown }
  if (typeof host !== 'string' || !isPhoneHost(host) || !isPort(port)) return null
  return { host, port }
}

export function parsePhoneAddress(text: string): GatewayPhoneAddress | null {
  const sep = text.lastIndexOf(':')
  if (sep <= 0) return null
  const port = text.slice(sep + 1)
  if (!PORT.test(port)) return null
  return phoneAddressOf({ host: text.slice(0, sep), port: Number(port) })
}

export function formatPhoneAddress(address: GatewayPhoneAddress): string {
  return `${address.host}:${address.port}`
}
