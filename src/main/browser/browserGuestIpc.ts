import { ipcMain, session, webContents } from 'electron'
import { browserPartition } from '../../shared/browser/browserProfile'
import { getByPaneId } from '../control/idRegistry'
import { clearGuestBrowseState } from './browseGuests'
import type { ConsoleEntry } from './browseMethod'
import { cancelPick } from './browsePick'
import type { BrowserGuests } from './browserGuests'
import { clearGuestNetwork } from './guestNetwork'
import type { GuestProfiles } from './guestProfiles'

interface BrowserGuestIpcDeps {
  browserProfiles: GuestProfiles['browserProfiles']
  browserPanes: Map<string, number>
  instrumentBrowserGuest: BrowserGuests['instrumentBrowserGuest']
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
    if (gc?.getType() !== 'webview' || gc.hostWebContents?.id !== e.sender.id) return
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
