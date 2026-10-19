import { beforeEach, describe, expect, it, vi } from 'vitest'

const bonjour = vi.hoisted(() => ({
  options: [] as unknown[],
  config: [] as Record<string, unknown>[],
  service: null as { records: () => unknown[]; stop: () => void } | null,
}))

const LAN = '192.168.2.108'
const RECORDS = [
  { name: 'x', type: 'PTR', data: 'p' },
  { name: 'x', type: 'SRV', data: {} },
  { name: 'x', type: 'TXT', data: {} },
  { name: 'h.local', type: 'A', data: LAN },
  { name: 'h.local', type: 'A', data: '100.64.1.2' },
  { name: 'h.local', type: 'A', data: '172.17.0.1' },
  { name: 'h.local', type: 'AAAA', data: '2001:db8::1' },
]

vi.mock('bonjour-service', () => ({
  Bonjour: class {
    constructor(options?: unknown) {
      bonjour.options.push(options)
    }
    publish(config: Record<string, unknown>) {
      bonjour.config.push(config)
      bonjour.service = { records: () => [...RECORDS], stop: () => {} }
      return bonjour.service
    }
    destroy() {}
  },
}))

const { createBonjourPublisher, lanAnnouncementFor } = await import('./announce')

beforeEach(() => {
  bonjour.options.length = 0
  bonjour.config.length = 0
  bonjour.service = null
})

describe('the Bonjour publisher', () => {
  it('RDS-C36 publishes only the bound address as an A record, and no AAAA', () => {
    const announcement = lanAnnouncementFor({ name: 'brave-apple', bindHost: LAN, port: 8722 })
    if (!announcement) throw new Error('no announcement')
    createBonjourPublisher().publish('lan', announcement)
    const types = (bonjour.service?.records() as Array<{ type: string; data: unknown }>).map(
      (r) => [r.type, r.type === 'A' ? r.data : null],
    )
    expect(types).toEqual([
      ['PTR', null],
      ['SRV', null],
      ['TXT', null],
      ['A', LAN],
    ])
    expect(bonjour.config[0]).toMatchObject({ disableIPv6: true, host: 'brave-apple.local' })
    expect(bonjour.options[0]).toEqual({ interface: LAN })
  })

  it('RDS-C37 marks the paired-phone announce by mode and keeps the format version', () => {
    expect(lanAnnouncementFor({ name: 'brave-apple', bindHost: LAN, port: 8722 })?.txt).toEqual({
      v: '1',
      mode: 'paired',
      port: '8722',
    })
  })
})
