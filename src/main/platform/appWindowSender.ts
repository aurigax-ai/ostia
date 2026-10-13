import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'

export function fromAppWindow(
  appWindows: () => Iterable<BrowserWindow>,
  e: IpcMainInvokeEvent,
): boolean {
  if (!e.senderFrame || e.senderFrame !== e.sender.mainFrame) return false
  const win = BrowserWindow.fromWebContents(e.sender)
  return win !== null && [...appWindows()].includes(win)
}
