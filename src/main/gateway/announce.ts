import { Bonjour, type Service, type ServiceConfig } from 'bonjour-service'
import { LOOPBACK_ADDRESS } from '../../shared/gateway/gatewayRoute'

export interface Announcement {
  name: string
  type: 'ostia'
  protocol: 'tcp'
  port: number
  txt: Record<string, string>
  host?: string
  iface?: string
}

export type AnnouncementKey = 'pairing' | 'lan'

export interface Publisher {
  publish: (key: AnnouncementKey, announcement: Announcement) => void
  unpublish: (key: AnnouncementKey) => void
  unpublishAll: () => void
}

interface AnnounceInput {
  discoverable: boolean
  liveCodes: number
  name: string
  host: string | null
  port: number | null
  fingerprint: string | null
}

export function announcementFor(input: AnnounceInput): Announcement | null {
  const { discoverable, liveCodes, name, host, port, fingerprint } = input
  if (!discoverable || liveCodes === 0 || !host || !port || !fingerprint) return null
  return {
    name,
    type: 'ostia',
    protocol: 'tcp',
    port,
    host: `${name}.local`,
    txt: { v: '1', name, host, port: String(port), fp: fingerprint },
  }
}

interface LanAnnounceInput {
  name: string
  bindHost: string | null
  port: number | null
}

export function lanAnnouncementFor({
  name,
  bindHost,
  port,
}: LanAnnounceInput): Announcement | null {
  if (!bindHost || bindHost === LOOPBACK_ADDRESS || !port) return null
  return {
    name,
    type: 'ostia',
    protocol: 'tcp',
    port,
    host: `${name}.local`,
    iface: bindHost,
    txt: { v: '1', mode: 'paired', port: String(port) },
  }
}

export function createBonjourPublisher(): Publisher {
  const running = new Map<AnnouncementKey, { bonjour: Bonjour; service: Service }>()
  const unpublish = (key: AnnouncementKey): void => {
    const entry = running.get(key)
    if (!entry) return
    running.delete(key)
    entry.service.stop?.()
    entry.bonjour.destroy()
  }
  return {
    publish: (key, { iface, ...announcement }) => {
      unpublish(key)
      const options: Partial<ServiceConfig> & { interface?: string } = { interface: iface }
      const bonjour = new Bonjour(iface ? options : undefined)
      const service = bonjour.publish({ ...announcement, disableIPv6: true })
      if (iface) {
        const records = service.records.bind(service)
        service.records = () =>
          records().filter((r) => (r.type === 'A' ? r.data === iface : r.type !== 'AAAA'))
      }
      running.set(key, { bonjour, service })
    },
    unpublish,
    unpublishAll: () => {
      for (const key of [...running.keys()]) unpublish(key)
    },
  }
}
