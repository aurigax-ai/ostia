export interface CwdReport {
  host: string
  path: string
}

const LOOPBACK_NAMES = ['', 'localhost']

let localHostName: string | null = null

export function parseOsc7(data: string): CwdReport | null {
  const match = /^file:\/\/([^/]*)(\/.*)$/.exec(data)
  return match ? { host: match[1], path: match[2] } : null
}

export function isLocalHost(host: string, local: string | null = localHostName): boolean {
  const name = host.toLowerCase()
  if (LOOPBACK_NAMES.includes(name) || local === null) return true
  const full = local.toLowerCase()
  return name === full || name === full.split('.')[0]
}

export async function loadLocalHostName(): Promise<void> {
  try {
    localHostName = (await window.ostia.info()).hostName || null
  } catch {
    localHostName = null
  }
}
