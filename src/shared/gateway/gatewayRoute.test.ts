import { describe, expect, it } from 'vitest'
import {
  formatPhoneAddress,
  isBindAddress,
  isBindInterface,
  parsePhoneAddress,
  resolveBindAddress,
} from './gatewayRoute'

describe('gateway route', () => {
  it('TSN-C43 accepts 127.0.0.1 and a machine IPv4 as bind addresses', () => {
    expect(isBindAddress('127.0.0.1')).toBe(true)
    expect(isBindAddress('192.168.2.108')).toBe(true)
  })

  it('TSN-C44 refuses 0.0.0.0, a hostname and anything else as a bind address', () => {
    for (const value of ['0.0.0.0', 'localhost', 'desk.example', '::1', '256.1.1.1', 8722, null]) {
      expect(isBindAddress(value)).toBe(false)
    }
  })

  it('TSN-C46 reads a host name or IPv4 and a port as the phone address', () => {
    expect(parsePhoneAddress('desk.example.ts.net:443')).toEqual({
      host: 'desk.example.ts.net',
      port: 443,
    })
    expect(parsePhoneAddress('203.0.113.7:8722')).toEqual({ host: '203.0.113.7', port: 8722 })
    expect(formatPhoneAddress({ host: 'desk.example', port: 8722 })).toBe('desk.example:8722')
  })

  it('TSN-C47 refuses a scheme, a path, a missing or bad port, and a bad host', () => {
    for (const text of [
      'https://desk.example:443',
      'desk.example:443/path',
      'desk.example',
      'desk.example:',
      'desk.example:0',
      'desk.example:65536',
      'desk.example:08722',
      ':8722',
      '999.1.1.1:8722',
      '-desk.example:8722',
      'desk..example:8722',
      'user@desk.example:8722',
      '[::1]:8722',
      'desk example:8722',
    ]) {
      expect(parsePhoneAddress(text)).toBeNull()
    }
  })

  describe('resolveBindAddress', () => {
    const lo = { address: '127.0.0.1', iface: 'lo', loopback: true }
    const wlan = { address: '192.168.2.108', iface: 'wlan0', loopback: false }
    const eth = { address: '10.0.0.5', iface: 'eth0', loopback: false }

    it('RDS-C20 keeps the saved address while its card still has it', () => {
      const route = { bindAddress: '192.168.2.108', bindInterface: 'wlan0' }
      expect(resolveBindAddress([lo, eth, wlan], route)).toBe('192.168.2.108')
    })

    it('RDS-C21 follows the card to its new address', () => {
      const route = { bindAddress: '192.168.2.108', bindInterface: 'wlan0' }
      expect(resolveBindAddress([lo, eth, { ...wlan, address: '172.16.1.9' }], route)).toBe(
        '172.16.1.9',
      )
    })

    it('RDS-C22 answers nothing when the card is gone, never another card', () => {
      const route = { bindAddress: '192.168.2.108', bindInterface: 'wlan0' }
      expect(resolveBindAddress([lo, eth], route)).toBeNull()
      expect(resolveBindAddress([lo, { ...eth, address: '192.168.2.108' }], route)).toBeNull()
    })

    it('RDS-C23 resolves a loopback route only to loopback', () => {
      expect(
        resolveBindAddress([lo, wlan], { bindAddress: '127.0.0.1', bindInterface: null }),
      ).toBe('127.0.0.1')
      expect(
        resolveBindAddress([wlan], { bindAddress: '127.0.0.1', bindInterface: null }),
      ).toBeNull()
    })
  })

  it('RDS-C24 accepts no card, or a named card, as the bind interface', () => {
    expect(isBindInterface(null)).toBe(true)
    expect(isBindInterface('wlan0')).toBe(true)
    for (const value of ['', 'x'.repeat(65), 4, undefined])
      expect(isBindInterface(value)).toBe(false)
  })
})
