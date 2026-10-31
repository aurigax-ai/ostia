import { app, type BrowserWindow } from 'electron'
import { isPreviewPartition } from '../../shared/artifacts/htmlPreview'
import { SHARED_BROWSER_PARTITION } from '../../shared/browser/browserProfile'
import type { CommandDescriptor } from '../../shared/control/commands'
import type { PreviewHost } from '../artifacts/htmlPreview'
import { hardenPreviewAttach } from '../artifacts/previewAttach'
import { clearGuestBrowseState } from '../browser/browseGuests'
import type { ConsoleEntry } from '../browser/browseMethod'
import type { BrowserGuests } from '../browser/browserGuests'
import type { GuestChords } from '../browser/guestChords'
import { forgetGuestNetwork } from '../browser/guestNetwork'
import { announceGuestPointer } from '../browser/guestPointer'
import type { GuestProfiles } from '../browser/guestProfiles'
import { tabReferrerOf } from '../browser/guestTabs'
import { followAgentByHost } from '../browser/signinUserAgent'
import { getByPaneId, removeWindow } from '../control/idRegistry'
import type { Diagnostics } from '../diagnostics/diagnostics'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { FileServices } from '../files/filesWiring'
import type { OpenWaits } from '../files/openWaits'
import { extensionOfViewerPartition } from '../files/viewers/viewerSessions'
import type { GitService } from '../git/service'
import type { ManagerService } from '../manager/manager'
import type { SettingsFile } from '../platform/settingsFile'
import type { PortsService } from '../ports/service'
import type { PtyIo } from '../terminal/pty/ptyIo'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { AppQuit } from './appQuit'
import type { ClipboardEdits } from './clipboardEdits'
import { attachContextMenu } from './contextMenu'
import type { ContextMenuText } from './contextMenuTemplate'
import { type AppTray, closeAction, readCloseToTray } from './tray'
import type { WindowBroker } from './windowBroker'

interface WindowWiringDeps {
  contextMenuText: () => ContextMenuText
  services: {
    appTray: AppTray | null
    broker: WindowBroker | null
    clipboardEdits: ClipboardEdits | null
    diagnostics: Diagnostics | null
    extensionHost: ExtensionHost | null
    files: FileServices | null
    gitService: GitService | null
    guestChords: GuestChords | null
    managerService: ManagerService | null
    portsService: PortsService | null
  }
  quit: {
    quitApproved: boolean
  }
  readSettingsFile: () => SettingsFile
  requestQuit: AppQuit['requestQuit']
  openExternalSafe: (url: string) => boolean
  previews: PreviewHost
  extensionOfPartition: BrowserGuests['extensionOfPartition']
  browserProfiles: GuestProfiles['browserProfiles']
  hardenExtensionGuest: BrowserGuests['hardenExtensionGuest']
  browserAgentsOf: BrowserGuests['browserAgentsOf']
  instrumentBrowserGuest: BrowserGuests['instrumentBrowserGuest']
  fenceBrowserGuest: GuestProfiles['fenceBrowserGuest']
  allowHumanPopups: BrowserGuests['allowHumanPopups']
  attachBrowserMenu: BrowserGuests['attachBrowserMenu']
  consoleBuffers: Map<number, ConsoleEntry[]>
  errorBuffers: Map<number, ConsoleEntry[]>
  windows: Map<string, BrowserWindow>
  hidePtyFlow: PtyIo['hidePtyFlow']
  releaseWindowPtys: (windowId: string) => void
  openWaits: OpenWaits
  commandsByWindow: Map<string, CommandDescriptor[]>
  browserPanes: Map<string, number>
  ptys: Map<string, PtyEntry>
}

function webviewGate(deps: WindowWiringDeps, win: BrowserWindow) {
  const { services, previews, extensionOfPartition, browserProfiles } = deps
  return (
    event: Electron.Event,
    webPreferences: Electron.WebPreferences,
    params: Record<string, string>,
  ): void => {
    if (extensionOfViewerPartition(params.partition)) {
      if (
        services.files?.viewers.acceptsAttach(
          params.partition,
          params.src,
          String(win.webContents.id),
        )
      ) {
        webPreferences.preload = undefined
        webPreferences.nodeIntegration = false
        webPreferences.contextIsolation = true
        webPreferences.sandbox = true
        Object.assign(webPreferences, { disablePopups: true })
      } else {
        event.preventDefault()
      }
      return
    }
    if (isPreviewPartition(params.partition)) {
      if (previews.acceptsAttach(params.partition, params.src, String(win.webContents.id))) {
        hardenPreviewAttach(webPreferences, params)
      } else {
        event.preventDefault()
      }
      return
    }
    const extId = extensionOfPartition(params.partition)
    const allowed = extId
      ? (services.extensionHost?.panels.isAllowedPanelUrl(extId, params.src) ?? false)
      : browserProfiles.acceptsAttach(params.partition, String(win.webContents.id))
    if (!allowed) {
      event.preventDefault()
      return
    }
    const referrer = extId ? undefined : tabReferrerOf(win.webContents.id, params.src)
    if (referrer) params.httpreferrer = referrer
    webPreferences.preload = undefined
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.navigateOnDragDrop = false
    Object.assign(webPreferences, {
      disablePopups: params.partition !== SHARED_BROWSER_PARTITION,
    })
  }
}

function guestAdopter(deps: WindowWiringDeps, owner: Electron.WebContents) {
  const {
    services,
    previews,
    contextMenuText,
    hardenExtensionGuest,
    attachBrowserMenu,
    browserAgentsOf,
    instrumentBrowserGuest,
    fenceBrowserGuest,
    allowHumanPopups,
    consoleBuffers,
    errorBuffers,
  } = deps
  return (_e: Electron.Event, guest: Electron.WebContents): void => {
    announceGuestPointer(guest, owner)
    services.clipboardEdits?.guardGuest(guest)
    services.guestChords?.guardGuest(guest)
    if (previews.adopt(guest)) return
    if (services.files?.viewers.adopt(guest)) {
      attachContextMenu(guest, false, contextMenuText)
      return
    }
    if (hardenExtensionGuest(guest)) {
      attachContextMenu(guest, false, contextMenuText)
      return
    }
    attachBrowserMenu(guest)
    const agents = browserAgentsOf(guest.session)
    guest.setUserAgent(agents.rewritten)
    instrumentBrowserGuest(guest, true)
    followAgentByHost(guest, agents)
    fenceBrowserGuest(guest)
    allowHumanPopups(guest)
    const wcId = guest.id
    guest.once('destroyed', () => {
      consoleBuffers.delete(wcId)
      errorBuffers.delete(wcId)
      forgetGuestNetwork(wcId)
    })
  }
}

function windowCleanup(deps: WindowWiringDeps, wid: string): void {
  const {
    services,
    previews,
    windows,
    releaseWindowPtys,
    openWaits,
    commandsByWindow,
    browserPanes,
    consoleBuffers,
    errorBuffers,
    ptys,
  } = deps
  windows.delete(wid)
  services.gitService?.windowGone(wid)
  services.portsService?.windowGone(wid)
  releaseWindowPtys(wid)
  previews.windowClosed(wid)
  services.files?.viewers.forgetWindow(wid)
  openWaits.windowGone(wid)
  services.files?.watches.unwatchOwner(wid)
  commandsByWindow.delete(wid)
  for (const [paneId, wcId] of browserPanes) {
    if (getByPaneId(paneId)?.windowId === wid) {
      browserPanes.delete(paneId)
      consoleBuffers.delete(wcId)
      errorBuffers.delete(wcId)
      clearGuestBrowseState(wcId)
      forgetGuestNetwork(wcId)
    }
  }
  removeWindow(wid)
  for (const entry of ptys.values()) {
    if (entry.subs.has(wid)) {
      entry.subs.delete(wid)
      entry.session.removeSubscriber(wid)
    }
  }
}

export type WindowWiring = ReturnType<typeof createWindowWiring>

export function createWindowWiring(deps: WindowWiringDeps) {
  const {
    contextMenuText,
    services,
    quit,
    readSettingsFile,
    requestQuit,
    openExternalSafe,
    windows,
    hidePtyFlow,
  } = deps
  const startedHidden = app.commandLine.hasSwitch('hidden')

  function wireWindow(win: BrowserWindow): void {
    win.once('ready-to-show', () => {
      if (startedHidden && services.appTray) services.appTray.hide(win)
      else win.show()
    })

    win.on('close', (event) => {
      if (quit.quitApproved || services.broker?.isReturning(win)) return
      const action = closeAction({
        quitApproved: quit.quitApproved,
        closeToTray: readCloseToTray(readSettingsFile()),
        startedHidden,
        managerLive: services.managerService?.live != null,
      })
      if (action === 'hide' && services.appTray && !services.broker?.isDetached(win)) {
        event.preventDefault()
        services.appTray.hide(win)
        return
      }
      event.preventDefault()
      if (services.broker?.isDetached(win)) services.broker.requestReturn(win, true)
      else requestQuit()
    })

    const emitMaximized = (): void => win.webContents.send('window:maximized', win.isMaximized())
    win.on('maximize', emitMaximized)
    win.on('unmaximize', emitMaximized)

    win.webContents.setWindowOpenHandler(({ url }) => {
      openExternalSafe(url)
      return { action: 'deny' }
    })

    attachContextMenu(win.webContents, false, contextMenuText)

    win.webContents.on('will-attach-webview', webviewGate(deps, win))
    win.webContents.on('did-attach-webview', guestAdopter(deps, win.webContents))

    const wid = String(win.webContents.id)
    windows.set(wid, win)
    services.diagnostics?.watchWindow(win)
    services.files?.viewers.followReloads(win.webContents, wid)
    win.on('hide', () => hidePtyFlow(wid))
    win.on('minimize', () => hidePtyFlow(wid))
    win.on('closed', () => {
      windowCleanup(deps, wid)
    })
  }

  return { wireWindow }
}
