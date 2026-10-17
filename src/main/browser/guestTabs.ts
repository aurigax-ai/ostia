import type { Referrer, WebContents } from 'electron'
import { type BrowserTabOpen, isTabUrl } from '../../shared/browser/linkTabs'

const BROWSER_OPEN_TAB = 'browser:open-tab'

export const TAB_REFERRER_MS = 30_000

const tabReferrers = new Map<string, { referrer: string; at: number }>()

const tabKey = (hostId: number, url: string): string => `${hostId} ${url}`

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export function tabReferrer({ url, policy }: Referrer, target: string): string {
  const from = originOf(url)
  if (!from || from === 'null' || policy === 'no-referrer') return ''
  if (policy === 'same-origin') return from === originOf(target) ? url : ''
  if (policy === 'origin' || policy === 'strict-origin') return `${from}/`
  return url
}

function rememberTabReferrer(hostId: number, url: string, referrer: string, now: number): void {
  for (const [key, entry] of tabReferrers) {
    if (now - entry.at > TAB_REFERRER_MS) tabReferrers.delete(key)
  }
  if (referrer) tabReferrers.set(tabKey(hostId, url), { referrer, at: now })
}

export function tabReferrerOf(
  hostId: number,
  url: string,
  now: number = Date.now(),
): string | undefined {
  const entry = tabReferrers.get(tabKey(hostId, url))
  return entry && now - entry.at <= TAB_REFERRER_MS ? entry.referrer : undefined
}

export function openGuestTab(
  guest: WebContents,
  url: string,
  background: boolean,
  referrer: Referrer,
  now: number = Date.now(),
): void {
  const host = guest.hostWebContents
  if (!host || host.isDestroyed() || !isTabUrl(url)) return
  rememberTabReferrer(host.id, url, tabReferrer(referrer, url), now)
  const open: BrowserTabOpen = { guestId: guest.id, url, background }
  host.send(BROWSER_OPEN_TAB, open)
}
