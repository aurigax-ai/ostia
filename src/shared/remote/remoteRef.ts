const REMOTE_REF = /^remote:([A-Za-z0-9][A-Za-z0-9._-]{0,252}):([0-9a-f]{8})$/
const PANE_ID = /^[0-9a-f]{8}$/

const DESKTOP_PREFIX = 'desktop:'

export function remoteRef(host: string, pane: string): string {
  return `remote:${host}:${pane}`
}

export function parseRemoteRef(text: string): { host: string; pane: string } | null {
  const match = REMOTE_REF.exec(text)
  return match ? { host: match[1], pane: match[2] } : null
}

export function remoteRoute(host: string): string {
  return `remote:${host}`
}

export function isPaneId(text: string): boolean {
  return PANE_ID.test(text)
}

export function desktopRef(pane: string): string {
  return `${DESKTOP_PREFIX}${pane}`
}

export function parseDesktopRef(text: string): string | null {
  return text.startsWith(DESKTOP_PREFIX) && text.length > DESKTOP_PREFIX.length
    ? text.slice(DESKTOP_PREFIX.length)
    : null
}

export function offlineNotice(host: string, since: string, waiting: number): string {
  return `${host} is offline since ${since}; ${waiting} message${waiting === 1 ? '' : 's'} wait and go when it is back.`
}

export function backNotice(host: string, delivered: number, expired: number): string {
  return `${host} is back; ${delivered} message${delivered === 1 ? '' : 's'} delivered, ${expired} expired.`
}
