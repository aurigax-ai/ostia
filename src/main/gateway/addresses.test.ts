import { describe, expect, it } from 'vitest'
import { gatewayAddresses, isCurrentHost } from './addresses'

const NODE = { ip: '100.101.102.103', dnsName: 'ostia-box.tail1234.ts.net' }

describe('gatewayAddresses', () => {
  it('RDS-C15 lists the tailnet name, the tailnet IPv4, the phone address and the LAN address, best first', () => {
    expect(
      gatewayAddresses({
        port: 8722,
        bindHost: '192.168.2.108',
        tailnet: NODE,
        phoneAddress: { host: 'gw.example.org', port: 443 },
        relayHost: null,
      }),
    ).toEqual([
      { kind: 'tailnet', host: 'ostia-box.tail1234.ts.net', port: 8722 },
      { kind: 'tailnet', host: '100.101.102.103', port: 8722 },
      { kind: 'phone', host: 'gw.example.org', port: 443 },
      { kind: 'lan', host: '192.168.2.108', port: 8722 },
    ])
  })

  it('RDS-C16 leaves out loopback and whatever does not exist now', () => {
    expect(
      gatewayAddresses({
        port: 8722,
        bindHost: '127.0.0.1',
        tailnet: null,
        phoneAddress: null,
        relayHost: null,
      }),
    ).toEqual([])
    expect(
      gatewayAddresses({
        port: 8722,
        bindHost: null,
        tailnet: { ip: '100.64.0.9', dnsName: null },
        phoneAddress: null,
        relayHost: null,
      }),
    ).toEqual([{ kind: 'tailnet', host: '100.64.0.9', port: 8722 }])
  })

  it('RLY-C40 lists the relay host on 443 after the tailnet, phone and LAN addresses', () => {
    expect(
      gatewayAddresses({
        port: 8722,
        bindHost: '192.168.2.108',
        tailnet: NODE,
        phoneAddress: { host: 'gw.example.org', port: 443 },
        relayHost: 'lblabc.relay.test',
      }).map((a) => a.kind),
    ).toEqual(['tailnet', 'tailnet', 'phone', 'lan', 'relay'])
    expect(
      gatewayAddresses({
        port: 8722,
        bindHost: null,
        tailnet: null,
        phoneAddress: null,
        relayHost: 'lblabc.relay.test',
      }),
    ).toEqual([{ kind: 'relay', host: 'lblabc.relay.test', port: 443 }])
  })

  it('RDS-C17 lists nothing while the gateway is not listening', () => {
    expect(
      gatewayAddresses({
        port: null,
        bindHost: null,
        tailnet: NODE,
        phoneAddress: null,
        relayHost: null,
      }),
    ).toEqual([])
  })
})

describe('isCurrentHost', () => {
  const addresses = gatewayAddresses({
    port: 8722,
    bindHost: '192.168.2.108',
    tailnet: NODE,
    phoneAddress: { host: 'gw.example.org', port: 443 },
    relayHost: null,
  })

  it('RDS-C18 accepts every current address, with its port or without one', () => {
    for (const host of [
      'ostia-box.tail1234.ts.net:8722',
      'ostia-box.tail1234.ts.net',
      'OSTIA-BOX.tail1234.ts.net',
      '100.101.102.103:8722',
      '192.168.2.108:8722',
      'gw.example.org:443',
      'gw.example.org',
      '127.0.0.1:8722',
      'localhost',
    ]) {
      expect(isCurrentHost(host, 8722, addresses), host).toBe(true)
    }
  })

  it('RDS-C19 refuses an address that is no longer current, or a known host on another port', () => {
    for (const host of [
      '100.101.102.104:8722',
      '192.168.2.109:8722',
      'old-box.tail1234.ts.net',
      'gw.example.org:8722',
      '192.168.2.108:443',
      '127.0.0.1:443',
      '',
    ]) {
      expect(isCurrentHost(host, 8722, addresses), host).toBe(false)
    }
    expect(isCurrentHost(undefined, 8722, addresses)).toBe(false)
    expect(isCurrentHost('127.0.0.1:8722', null, addresses)).toBe(false)
  })
})

describe('isCurrentHost with the relay', () => {
  const addresses = gatewayAddresses({
    port: 8722,
    bindHost: null,
    tailnet: null,
    phoneAddress: null,
    relayHost: 'lblabc.relay.test',
  })

  it('RLY-C41 accepts the relay host with 443 or no port, and nothing else on it', () => {
    expect(isCurrentHost('lblabc.relay.test', 8722, addresses)).toBe(true)
    expect(isCurrentHost('LBLABC.relay.test:443', 8722, addresses)).toBe(true)
    expect(isCurrentHost('lblabc.relay.test:8722', 8722, addresses)).toBe(false)
    expect(isCurrentHost('other.relay.test', 8722, addresses)).toBe(false)
  })

  it('RLY-C42 stops accepting the relay host once no address lists it', () => {
    const without = gatewayAddresses({
      port: 8722,
      bindHost: null,
      tailnet: null,
      phoneAddress: null,
      relayHost: null,
    })
    expect(isCurrentHost('lblabc.relay.test', 8722, without)).toBe(false)
  })
})
