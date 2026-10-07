import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { bindAddressesOf } from './interfaces'

function info(address: string, family: 'IPv4' | 'IPv6', internal: boolean): NetworkInterfaceInfo {
  return {
    address,
    family,
    internal,
    netmask: '255.0.0.0',
    mac: '00:00:00:00:00:00',
    cidr: null,
    ...(family === 'IPv6' ? { scopeid: 0 } : {}),
  } as NetworkInterfaceInfo
}

describe('bindAddressesOf', () => {
  it('TSN-C43 lists loopback first, then each IPv4 of this machine once', () => {
    expect(
      bindAddressesOf({
        wlan0: [info('192.168.2.108', 'IPv4', false), info('fe80::1', 'IPv6', false)],
        lo: [info('127.0.0.1', 'IPv4', true), info('::1', 'IPv6', true)],
        tun0: [info('10.8.0.2', 'IPv4', false), info('192.168.2.108', 'IPv4', false)],
      }),
    ).toEqual([
      { address: '127.0.0.1', iface: 'lo', loopback: true },
      { address: '192.168.2.108', iface: 'wlan0', loopback: false },
      { address: '10.8.0.2', iface: 'tun0', loopback: false },
    ])
  })

  it('TSN-C44 never lists 0.0.0.0', () => {
    expect(bindAddressesOf({ any: [info('0.0.0.0', 'IPv4', false)] })).toEqual([])
  })
})
