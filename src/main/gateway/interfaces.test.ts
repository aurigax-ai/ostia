import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { classifyAddresses, isTailscaleCgnat } from './interfaces'

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  }
}

describe('isTailscaleCgnat', () => {
  it('matches only 100.64.0.0/10', () => {
    expect(isTailscaleCgnat('100.64.0.1')).toBe(true)
    expect(isTailscaleCgnat('100.127.255.254')).toBe(true)
    expect(isTailscaleCgnat('100.63.0.1')).toBe(false)
    expect(isTailscaleCgnat('100.128.0.1')).toBe(false)
    expect(isTailscaleCgnat('192.168.1.2')).toBe(false)
  })
})

describe('classifyAddresses', () => {
  it('lists loopback first, then LAN, then Tailscale, skipping internal and IPv6', () => {
    const ifaces = {
      lo: [v4('127.0.0.1', true)],
      wlan0: [v4('192.168.1.20'), { ...v4('fe80::1'), family: 'IPv6' as const, scopeid: 0 }],
      tailscale0: [v4('100.101.102.103')],
    }
    expect(classifyAddresses(ifaces, [])).toEqual([
      { address: '127.0.0.1', kind: 'loopback' },
      { address: '192.168.1.20', kind: 'lan', iface: 'wlan0' },
      { address: '100.101.102.103', kind: 'tailscale', iface: 'tailscale0' },
    ])
  })

  it('lists a Tailscale address from the CLI once, even when an interface also has it', () => {
    const ifaces = { tailscale0: [v4('100.90.1.1')] }
    expect(classifyAddresses(ifaces, ['100.90.1.1'])).toEqual([
      { address: '127.0.0.1', kind: 'loopback' },
      { address: '100.90.1.1', kind: 'tailscale' },
    ])
  })

  it('offers loopback alone when there is no network', () => {
    expect(classifyAddresses({}, [])).toEqual([{ address: '127.0.0.1', kind: 'loopback' }])
  })
})
