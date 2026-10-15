import type { WebContents } from 'electron'
import { type BrowserTabOpen, isTabUrl } from '../../shared/browser/linkTabs'

const BROWSER_OPEN_TAB = 'browser:open-tab'

export function openGuestTab(guest: WebContents, url: string, background: boolean): void {
  const host = guest.hostWebContents
  if (!host || host.isDestroyed() || !isTabUrl(url)) return
  const open: BrowserTabOpen = { guestId: guest.id, url, background }
  host.send(BROWSER_OPEN_TAB, open)
}
