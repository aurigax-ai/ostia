export const FORWARD_MAX = 32
export const PORTS_POLL_MS = 2000
export const LOCAL_PORT_MIN = 1024
export const LOCAL_PORT_MAX = 65535

export interface HostPort {
  port: number
  name?: string
}

export type PortOp = 'list' | 'forward' | 'stop'

export interface ForwardRow {
  remote: number
  name?: string
  local?: number
  error?: string
}

export type PortsResult = { ok: true; forwards: ForwardRow[] } | { ok: false; error: string }

export function validLocalPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= LOCAL_PORT_MIN &&
    value <= LOCAL_PORT_MAX
  )
}

export function validRemotePort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

export function parseLocalPort(text: string): number | null | 'bad' {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (!/^\d{1,5}$/.test(trimmed)) return 'bad'
  const port = Number(trimmed)
  return validLocalPort(port) ? port : 'bad'
}
