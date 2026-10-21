import type { GatewayPhoneAddress } from '../../shared/gateway/gatewayApi'
import { LOOPBACK_ADDRESS } from '../../shared/gateway/gatewayRoute'

export const RELAY_PORT = 443

export interface GatewayAddress {
  kind: 'tailnet' | 'phone' | 'lan' | 'relay'
  host: string
  port: number
}

export interface TailnetNode {
  ip: string | null
  dnsName: string | null
}

interface AddressSources {
  port: number | null
  bindHost: string | null
  tailnet: TailnetNode | null
  phoneAddress: GatewayPhoneAddress | null
  relayHost: string | null
}

export function gatewayAddresses({
  port,
  bindHost,
  tailnet,
  phoneAddress,
  relayHost,
}: AddressSources): GatewayAddress[] {
  if (!port) return []
  const found: GatewayAddress[] = []
  if (tailnet?.dnsName) found.push({ kind: 'tailnet', host: tailnet.dnsName, port })
  if (tailnet?.ip) found.push({ kind: 'tailnet', host: tailnet.ip, port })
  if (phoneAddress) found.push({ kind: 'phone', ...phoneAddress })
  if (bindHost && bindHost !== LOOPBACK_ADDRESS) found.push({ kind: 'lan', host: bindHost, port })
  if (relayHost) found.push({ kind: 'relay', host: relayHost, port: RELAY_PORT })
  return found
}

export function isCurrentHost(
  hostHeader: string | undefined,
  port: number | null,
  addresses: GatewayAddress[],
): boolean {
  if (!port || typeof hostHeader !== 'string' || !hostHeader) return false
  const sep = hostHeader.lastIndexOf(':')
  const host = (sep === -1 ? hostHeader : hostHeader.slice(0, sep)).toLowerCase()
  const headerPort = sep === -1 ? undefined : Number(hostHeader.slice(sep + 1))
  const reaches = (wanted: string, wantedPort: number): boolean =>
    host === wanted.toLowerCase() && (headerPort === undefined || headerPort === wantedPort)
  return (
    reaches(LOOPBACK_ADDRESS, port) ||
    reaches('localhost', port) ||
    addresses.some((a) => reaches(a.host, a.port))
  )
}
