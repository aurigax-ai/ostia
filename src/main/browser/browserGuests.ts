import { app, BrowserWindow, session } from 'electron'
import { SHARED_BROWSER_PARTITION } from '../../shared/browser/browserProfile'
import { PASSKEY_GUARD_JS } from '../../shared/browser/passkeyGuard'
import type { ExtensionHost } from '../extensions/extensionHost'
import { attachContextMenu } from '../windows/contextMenu'
import type { ContextMenuText } from '../windows/contextMenuTemplate'
import { pushConsoleEntry } from './browse'
import type { ConsoleEntry } from './browseMethod'
import { injectPageScripts, OSTIA_ERROR_PREFIX, PAGE_ERROR_CATCHER_JS } from './browsePageScripts'
import { holdFirstLoad } from './guestFirstLoad'
import { clickedLinkOf, LINK_CLICK_SCRIPT } from './guestLinkClicks'
import { watchGuestNetwork } from './guestNetwork'
import { openHumanPopups } from './guestPopups'
import { openGuestTab, tabReferrerOf } from './guestTabs'
import { type BrowserAgents, followAgentByHost, useBrowserAgents } from './signinUserAgent'

interface BrowserGuestsDeps {
  contextMenuText: () => ContextMenuText
  consoleBuffers: Map<number, ConsoleEntry[]>
  errorBuffers: Map<number, ConsoleEntry[]>
  windows: Map<string, BrowserWindow>
  services: {
    extensionHost: ExtensionHost | null
  }
  openExternalSafe: (url: string) => boolean
}

export type BrowserGuests = ReturnType<typeof createBrowserGuests>

export function createBrowserGuests({
  contextMenuText,
  consoleBuffers,
  errorBuffers,
  windows,
  services,
  openExternalSafe,
}: BrowserGuestsDeps) {
  const EXTENSION_PARTITION_PREFIX = 'ostia-ext-'

  function extensionOfPartition(partition: string | undefined): string | null {
    if (!partition?.startsWith(EXTENSION_PARTITION_PREFIX)) return null
    return partition.slice(EXTENSION_PARTITION_PREFIX.length)
  }

  function browserAgentsOf(target: Electron.Session): BrowserAgents {
    return useBrowserAgents(target, app.getName(), {
      chromeVersion: process.versions.chrome,
      platform: process.platform,
      systemVersion: process.getSystemVersion(),
      arch: process.arch,
    })
  }

  function isHumanProfile(guest: Electron.WebContents): boolean {
    return guest.session === session.fromPartition(SHARED_BROWSER_PARTITION)
  }

  function tabReferrerOfGuest(guest: Electron.WebContents, url: string): string | undefined {
    const host = guest.hostWebContents
    return host ? tabReferrerOf(host.id, url) : undefined
  }

  const instrumentedGuests = new WeakSet<Electron.WebContents>()

  function instrumentBrowserGuest(gc: Electron.WebContents, attaching = false): void {
    const wcId = gc.id
    if (!instrumentedGuests.has(gc)) {
      instrumentedGuests.add(gc)
      gc.on('console-message', (event) => {
        if (clickedLinkOf(event.message) !== null) return
        const entry: ConsoleEntry = {
          level: event.level,
          text: event.message,
          ts: Date.now(),
        }
        pushConsoleEntry(consoleBuffers, wcId, entry)
        if (entry.level === 'error' || event.message.startsWith(OSTIA_ERROR_PREFIX)) {
          pushConsoleEntry(errorBuffers, wcId, entry)
        }
      })
    }
    if (!gc.debugger.isAttached()) {
      let registered: Promise<unknown> = Promise.resolve()
      try {
        gc.debugger.attach('1.3')
        const linkClicks = isHumanProfile(gc) ? [LINK_CLICK_SCRIPT] : []
        registered = injectPageScripts(gc, [PAGE_ERROR_CATCHER_JS, PASSKEY_GUARD_JS, ...linkClicks])
      } catch {}
      if (attaching) void holdFirstLoad(gc, registered, (url) => tabReferrerOfGuest(gc, url))
    }
    watchGuestNetwork(gc)
  }

  function prepareBrowserPopup(popup: BrowserWindow, url: string): void {
    const contents = popup.webContents
    attachContextMenu(contents, true, contextMenuText)
    const agents = browserAgentsOf(contents.session)
    contents.setUserAgent(agents.rewritten)
    try {
      contents.debugger.attach('1.3')
    } catch {}
    followAgentByHost(contents, agents, url)
  }

  function attachBrowserMenu(guest: Electron.WebContents): void {
    const openLinkInNewTab = isHumanProfile(guest)
      ? (url: string, referrer: Electron.Referrer) => openGuestTab(guest, url, true, referrer)
      : undefined
    attachContextMenu(guest, true, contextMenuText, openLinkInNewTab)
  }

  function allowHumanPopups(guest: Electron.WebContents): void {
    openHumanPopups(guest, {
      isHumanProfile,
      ownerWindow: (opener) => {
        const host = opener.hostWebContents
        const owner = host ? BrowserWindow.fromWebContents(host) : null
        return owner && [...windows.values()].includes(owner) ? owner : null
      },
      prepare: prepareBrowserPopup,
      openTab: openGuestTab,
    })
  }

  function hardenExtensionGuest(guest: Electron.WebContents): boolean {
    const host = services.extensionHost
    if (!host) return false
    const extId = host.panels
      .panelExtensionIds()
      .find((id) => guest.session === session.fromPartition(`${EXTENSION_PARTITION_PREFIX}${id}`))
    if (!extId) return false
    guest.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    guest.setWindowOpenHandler(({ url }) => {
      openExternalSafe(url)
      return { action: 'deny' }
    })
    const guard = (e: Electron.Event, url: string): void => {
      if (!host.panels.isAllowedPanelUrl(extId, url)) e.preventDefault()
    }
    guest.on('will-navigate', guard)
    guest.on('will-redirect', guard)
    return true
  }

  return {
    extensionOfPartition,
    browserAgentsOf,
    instrumentBrowserGuest,
    attachBrowserMenu,
    allowHumanPopups,
    hardenExtensionGuest,
    isHumanProfile,
  }
}
