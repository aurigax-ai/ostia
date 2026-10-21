import type { BrowserTabOpen } from '@shared/browser/linkTabs'
import { workspaceOfPane } from '@/lib/attention/workspaceActivity'
import { browserPaneOfGuest } from '@/lib/browser/browserHandles'
import { markOpenedQuietly } from '@/lib/files/openFile'
import { paneBrowserProfile } from '@/lib/layout/paneFields'
import { findPane } from '@/lib/layout/tree'
import { openKeepingFocus } from '@/lib/panes/callerFocus'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

export function openLinkTab({ guestId, url, background }: BrowserTabOpen): string | null {
  const opener = browserPaneOfGuest(guestId)
  const workspaceId = opener ? workspaceOfPane(opener) : null
  const root = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId]?.root : undefined
  const pane = opener && root ? findPane(root, opener) : null
  if (!workspaceId || !pane) return null
  const open = (): string | null =>
    useLayoutStore
      .getState()
      .openBrowserTab(workspaceId, url, paneBrowserProfile(pane), { beside: pane.id, background })
  if (!background) return open()
  const opened = openKeepingFocus(open)
  if (opened) markOpenedQuietly(opened, url)
  return opened
}

export function wireLinkTabs(): () => void {
  return window.ostia.browser.onOpenTab(openLinkTab)
}
