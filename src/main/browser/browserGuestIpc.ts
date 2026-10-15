import { ipcMain, session, webContents } from 'electron'
import { browserPartition } from '../../shared/browser/browserProfile'
import { getByPaneId } from '../control/idRegistry'
import { clearGuestBrowseState } from './browseGuests'
import type { ConsoleEntry } from './browseMethod'
import { cancelPick } from './browsePick'
import type { BrowserProfiles } from './browserProfiles'
import { clearGuestNetwork } from './guestNetwork'

interface BrowserGuestIpcDeps {
  browserProfiles: BrowserProfiles
  browserPanes: Map<string, number>
  instrumentBrowserGuest: (gc: Electron.WebContents, attaching?: boolean) => void
  consoleBuffers: Map<number, ConsoleEntry[]>
  errorBuffers: Map<number, ConsoleEntry[]>
}

export function registerBrowserGuestIpc({
  browserProfiles,
  browserPanes,
  instrumentBrowserGuest,
  consoleBuffers,
  errorBuffers,
}: BrowserGuestIpcDeps) {
  ipcMain.handle('browser:claim-profile', (e, paneId: unknown, profile: unknown) =>
    browserProfiles.claim(paneId, String(e.sender.id), profile),
  )
  ipcMain.on('browser:register', (e, paneId: string, webContentsId: number) => {
    const wid = String(e.sender.id)
    if (getByPaneId(paneId)?.windowId !== wid) return
    const gc = webContents.fromId(webContentsId)
    if (!gc || gc.getType() !== 'webview' || gc.hostWebContents?.id !== e.sender.id) return
    const expected = browserPartition(browserProfiles.profileOf(paneId), paneId)
    if (gc.session !== session.fromPartition(expected)) return
    browserPanes.set(paneId, webContentsId)
    instrumentBrowserGuest(gc)
  })
  ipcMain.on('browser:unregister', (e, paneId: string) => {
    const owner = getByPaneId(paneId)?.windowId
    if (owner && owner !== String(e.sender.id)) return
    cancelPick(paneId)
    const wcId = browserPanes.get(paneId)
    browserPanes.delete(paneId)
    if (wcId !== undefined) {
      consoleBuffers.delete(wcId)
      errorBuffers.delete(wcId)
      clearGuestBrowseState(wcId)
      clearGuestNetwork(wcId)
    }
  })
}
