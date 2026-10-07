import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os'
import type { GatewayBindAddress } from '../../shared/types'

export function bindAddressesOf(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): GatewayBindAddress[] {
  const out: GatewayBindAddress[] = []
  for (const [iface, infos] of Object.entries(ifaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.address === '0.0.0.0') continue
      if (out.some((a) => a.address === info.address)) continue
      out.push({ address: info.address, iface, loopback: info.internal })
    }
  }
  return [...out.filter((a) => a.loopback), ...out.filter((a) => !a.loopback)]
}

export function listBindAddresses(): GatewayBindAddress[] {
  return bindAddressesOf(networkInterfaces())
}
