import { execFile } from 'node:child_process'
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os'
import type { GatewayBindAddress } from '../../shared/types'

export const LOOPBACK_ADDRESS = '127.0.0.1'

const TAILSCALE_TIMEOUT_MS = 2000

export function isTailscaleCgnat(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 100 && b >= 64 && b <= 127
}

export function classifyAddresses(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  tailscaleIps: string[],
): GatewayBindAddress[] {
  const out: GatewayBindAddress[] = [{ address: LOOPBACK_ADDRESS, kind: 'loopback' }]
  const seen = new Set<string>([LOOPBACK_ADDRESS])
  const tailscale = new Set(tailscaleIps)
  const add = (entry: GatewayBindAddress): void => {
    if (seen.has(entry.address)) return
    seen.add(entry.address)
    out.push(entry)
  }
  for (const address of tailscaleIps) add({ address, kind: 'tailscale' })
  for (const [iface, infos] of Object.entries(ifaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const isTailscale = tailscale.has(info.address) || isTailscaleCgnat(info.address)
      add({ address: info.address, kind: isTailscale ? 'tailscale' : 'lan', iface })
    }
  }
  const rank = { loopback: 0, lan: 1, tailscale: 2, custom: 3 }
  return out.sort((x, y) => rank[x.kind] - rank[y.kind])
}

export function tailscaleIpv4(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('tailscale', ['ip', '-4'], { timeout: TAILSCALE_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        resolve([])
        return
      }
      resolve(
        stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /^\d{1,3}(\.\d{1,3}){3}$/.test(l)),
      )
    })
  })
}

export async function listBindAddresses(): Promise<GatewayBindAddress[]> {
  return classifyAddresses(networkInterfaces(), await tailscaleIpv4())
}
