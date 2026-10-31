import {
  type ForwardRow,
  type HostPort,
  type PortOp,
  type PortsResult,
  validRemotePort,
} from './remotePorts'

export const LINK_FRAME_MAX = 1024 * 1024
export const LINK_HEARTBEAT_MS = 15_000
export const LINK_DEAD_MS = 45_000

interface MailFrame {
  t: 'mail'
  id: string
  from: string
  to: string
  text: string
}

export type LinkFrame =
  | { t: 'hello'; version: string }
  | { t: 'hello-ok'; version: string }
  | { t: 'incompatible'; version: string }
  | MailFrame
  | { t: 'stored'; id: string }
  | { t: 'refused'; id: string; reason: string }
  | { t: 'hb' }
  | { t: 'ports'; ports: HostPort[] }
  | { t: 'ports-req'; id: string; op: PortOp; remote?: number; local?: number }
  | { t: 'ports-res'; id: string; result: PortsResult }

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

const PORTS_FRAME_MAX = 4096
const PORT_OPS: readonly string[] = ['list', 'forward', 'stop']

function hostPorts(value: unknown): HostPort[] | null {
  if (!Array.isArray(value) || value.length > PORTS_FRAME_MAX) return null
  const out: HostPort[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null
    const { port, name } = item as { port?: unknown; name?: unknown }
    if (!validRemotePort(port)) return null
    if (name !== undefined && !text(name, 64)) return null
    out.push(name === undefined ? { port } : { port, name })
  }
  return out
}

function forwardRows(value: unknown): ForwardRow[] | null {
  if (!Array.isArray(value) || value.length > PORTS_FRAME_MAX) return null
  const out: ForwardRow[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null
    const { remote, name, local, error } = item as Record<string, unknown>
    if (!validRemotePort(remote)) return null
    if (name !== undefined && !text(name, 64)) return null
    if (local !== undefined && !validRemotePort(local)) return null
    if (error !== undefined && !text(error, 200)) return null
    out.push({
      remote,
      ...(name === undefined ? {} : { name }),
      ...(local === undefined ? {} : { local }),
      ...(error === undefined ? {} : { error }),
    })
  }
  return out.length <= PORTS_FRAME_MAX ? out : null
}

function portsResult(value: unknown): PortsResult | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw.ok === true) {
    const forwards = forwardRows(raw.forwards)
    return forwards ? { ok: true, forwards } : null
  }
  return raw.ok === false && text(raw.error, 64) ? { ok: false, error: raw.error } : null
}

export function parseFrame(line: string): LinkFrame | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  switch (raw.t) {
    case 'hb':
      return { t: 'hb' }
    case 'hello':
    case 'hello-ok':
    case 'incompatible':
      return text(raw.version, 64) ? { t: raw.t, version: raw.version } : null
    case 'stored':
      return text(raw.id, 100) ? { t: 'stored', id: raw.id } : null
    case 'refused':
      return text(raw.id, 100) && text(raw.reason, 64)
        ? { t: 'refused', id: raw.id, reason: raw.reason }
        : null
    case 'mail':
      return text(raw.id, 100) &&
        text(raw.from, 100) &&
        text(raw.to, 100) &&
        text(raw.text, LINK_FRAME_MAX)
        ? { t: 'mail', id: raw.id, from: raw.from, to: raw.to, text: raw.text }
        : null
    case 'ports': {
      const ports = hostPorts(raw.ports)
      return ports ? { t: 'ports', ports } : null
    }
    case 'ports-req': {
      if (!text(raw.id, 100) || typeof raw.op !== 'string' || !PORT_OPS.includes(raw.op))
        return null
      if (raw.remote !== undefined && !validRemotePort(raw.remote)) return null
      if (raw.local !== undefined && !Number.isInteger(raw.local)) return null
      return {
        t: 'ports-req',
        id: raw.id,
        op: raw.op as PortOp,
        ...(raw.remote === undefined ? {} : { remote: raw.remote as number }),
        ...(raw.local === undefined ? {} : { local: raw.local as number }),
      }
    }
    case 'ports-res': {
      const result = portsResult(raw.result)
      return text(raw.id, 100) && result ? { t: 'ports-res', id: raw.id, result } : null
    }
    default:
      return null
  }
}

export function frameLine(frame: LinkFrame): string {
  return `${JSON.stringify(frame)}\n`
}
