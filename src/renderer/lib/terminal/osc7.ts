import { isHostNamed } from '@shared/terminal/osc7'

export { type CwdReport, parseOsc7 } from '@shared/terminal/osc7'

let localHostName: string | null = null

export function isLocalHost(host: string, local: string | null = localHostName): boolean {
  return isHostNamed(host, local)
}

export async function loadLocalHostName(): Promise<void> {
  try {
    localHostName = (await window.ostia.info()).hostName || null
  } catch {
    localHostName = null
  }
}
