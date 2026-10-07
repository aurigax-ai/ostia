import { Bonjour, type Service } from 'bonjour-service'

export interface Announcement {
  name: string
  type: 'ostia'
  protocol: 'tcp'
  port: number
  txt: Record<string, string>
}

export interface Publisher {
  publish: (announcement: Announcement) => void
  unpublish: () => void
}

export interface AnnounceInput {
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
    txt: { v: '1', name, host, port: String(port), fp: fingerprint },
  }
}

export function sameAnnouncement(a: Announcement | null, b: Announcement | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function createBonjourPublisher(): Publisher {
  let bonjour: Bonjour | null = null
  let service: Service | null = null
  const unpublish = (): void => {
    service?.stop?.()
    service = null
    bonjour?.destroy()
    bonjour = null
  }
  return {
    publish: (announcement) => {
      unpublish()
      bonjour = new Bonjour()
      service = bonjour.publish(announcement)
    },
    unpublish,
  }
}
