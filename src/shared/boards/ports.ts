import type { CoreItems } from './git'
import { clampedNumber } from './git'

export type PortHost = 'localhost' | '127.0.0.1'

export interface PortsSettings {
  enabled: boolean
  intervalSeconds: number
  portHost: PortHost
}

export const PORTS_INTERVAL_SECONDS = { min: 1, max: 60 }

export const DEFAULT_PORTS_SETTINGS: PortsSettings = {
  enabled: true,
  intervalSeconds: 3,
  portHost: 'localhost',
}

export function parsePortsSettings(raw: unknown): PortsSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    enabled: r.enabled !== false,
    intervalSeconds: clampedNumber(
      r.intervalSeconds,
      DEFAULT_PORTS_SETTINGS.intervalSeconds,
      PORTS_INTERVAL_SECONDS,
    ),
    portHost: r.portHost === '127.0.0.1' ? '127.0.0.1' : 'localhost',
  }
}

export interface PortsBridge {
  watch: (workspaceIds: string[]) => void
  onItems: (cb: (items: CoreItems) => void) => () => void
}
