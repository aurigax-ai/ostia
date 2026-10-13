export interface CwdReport {
  host: string
  path: string
}

const LOOPBACK_NAMES = ['', 'localhost']

export function parseOsc7(data: string): CwdReport | null {
  const match = /^file:\/\/([^/]*)(\/.*)$/.exec(data)
  return match ? { host: match[1], path: match[2] } : null
}

export function isHostNamed(host: string, local: string | null): boolean {
  const name = host.toLowerCase()
  if (LOOPBACK_NAMES.includes(name) || local === null) return true
  const full = local.toLowerCase()
  return name === full || name === full.split('.')[0]
}
