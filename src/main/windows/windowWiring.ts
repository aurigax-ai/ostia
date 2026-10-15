import { type BrowserWindow, app } from 'electron'
import { isPreviewPartition } from '../../shared/artifacts/htmlPreview'
import { SHARED_BROWSER_PARTITION } from '../../shared/browser/browserProfile'
import type { CommandDescriptor } from '../../shared/types'
import { hardenPreviewAttach } from '../artifacts/htmlPreview'
import type { PreviewHost } from '../artifacts/htmlPreview'
import { clearGuestBrowseState } from '../browser/browseGuests'
import type { ConsoleEntry } from '../browser/browseMethod'
import type { BrowserProfiles } from '../browser/browserProfiles'
import type { GuestChords } from '../browser/guestChords'
import { forgetGuestNetwork } from '../browser/guestNetwork'
import { followAgentByHost } from '../browser/signinUserAgent'
import type { BrowserAgents } from '../browser/signinUserAgent'
import { getByPaneId, removeWindow } from '../control/idRegistry'
import type { Diagnostics } from '../diagnostics/diagnostics'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { FileWatches } from '../files/fileWatch'
import type { OpenWaits } from '../files/openWaits'
import type { GitService } from '../git/service'
import type { ManagerService } from '../manager/manager'
import type { PortsService } from '../ports/service'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { ClipboardEdits } from './clipboardEdits'
import { attachContextMenu } from './contextMenu'
import { type AppTray, closeAction, readCloseToTray } from './tray'
import type { WindowBroker } from './windowBroker'

interface WindowWiringDeps {
  services: {
    appTray: AppTray | null
    broker: WindowBroker | null
    clipboardEdits: ClipboardEdits | null
    diagnostics: Diagnostics | null
    extensionHost: ExtensionHost | null
    fileWatches: FileWatches | null
    gitService: GitService | null
    guestChords: GuestChords | null
    managerService: ManagerService | null
    portsService: PortsService | null
  }
  quit: {
    quitApproved: boolean
  }
  readSettingsFile: () => {
    locale?: unknown
    extensionSettings?: unknown
    git?: unknown
    ports?: unknown
    workspaces?: { globalHotkey?: unknown; confirmQuit?: unknown }
    manager?: unknown
    assistant?: unknown
    privacy?: unknown
    terminal?: { shell?: unknown; keepShells?: unknown }
    agents?: { hooks?: unknown }
    behavior?: { historySuggestions?: unknown }
  }
  requestQuit: () => void
  openExternalSafe: (url: string) => boolean
  previews: PreviewHost
  extensionOfPartition: (partition: string | undefined) => string | null
  browserProfiles: BrowserProfiles
  hardenExtensionGuest: (guest: Electron.WebContents) => boolean
  browserAgentsOf: (target: Electron.Session) => BrowserAgents
  instrumentBrowserGuest: (gc: Electron.WebContents, attaching?: boolean) => void
  fenceBrowserGuest: (guest: Electron.WebContents) => void
  allowHumanPopups: (guest: Electron.WebContents) => void
  consoleBuffers: Map<number, ConsoleEntry[]>
  errorBuffers: Map<number, ConsoleEntry[]>
  windows: Map<string, BrowserWindow>
  hidePtyFlow: (wid: string) => void
  releaseWindowPtys: (windowId: string) => void
  openWaits: OpenWaits
  commandsByWindow: Map<string, CommandDescriptor[]>
  browserPanes: Map<string, number>
  ptys: Map<string, PtyEntry>
}

export function createWindowWiring({
  services,
  quit,
  readSettingsFile,
  requestQuit,
  openExternalSafe,
  previews,
  extensionOfPartition,
  browserProfiles,
  hardenExtensionGuest,
  browserAgentsOf,
  instrumentBrowserGuest,
  fenceBrowserGuest,
  allowHumanPopups,
  consoleBuffers,
  errorBuffers,
  windows,
  hidePtyFlow,
  releaseWindowPtys,
  openWaits,
  commandsByWindow,
  browserPanes,
  ptys,
}: WindowWiringDeps) {
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

    attachContextMenu(win.webContents, false)

    win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
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
      webPreferences.preload = undefined
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      Object.assign(webPreferences, {
        disablePopups: params.partition !== SHARED_BROWSER_PARTITION,
      })
    })
    win.webContents.on('did-attach-webview', (_e, guest) => {
      services.clipboardEdits?.guardGuest(guest)
      services.guestChords?.guardGuest(guest)
      if (previews.adopt(guest)) return
      if (hardenExtensionGuest(guest)) {
        attachContextMenu(guest, false)
        return
      }
      attachContextMenu(guest, true)
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
    })

    const wid = String(win.webContents.id)
    windows.set(wid, win)
    services.diagnostics?.watchWindow(win)
    win.on('hide', () => hidePtyFlow(wid))
    win.on('minimize', () => hidePtyFlow(wid))
    win.on('closed', () => {
      windows.delete(wid)
      services.gitService?.windowGone(wid)
      services.portsService?.windowGone(wid)
      releaseWindowPtys(wid)
      previews.windowClosed(wid)
      openWaits.windowGone(wid)
      services.fileWatches?.unwatchOwner(wid)
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
    })
  }

  return { wireWindow }
}
