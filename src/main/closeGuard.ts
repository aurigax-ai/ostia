import { type BrowserWindow, ipcMain } from 'electron'

interface PendingAnswer {
  senderId: number
  settle: (approved: boolean) => void
}

let lastRequestId = 0
const pending = new Map<number, PendingAnswer>()

export function registerCloseGuard(): void {
  ipcMain.on('window:close-answer', (e, requestId: number, approved: boolean) => {
    const answer = pending.get(requestId)
    if (answer && answer.senderId === e.sender.id) answer.settle(approved === true)
  })
}

export function confirmWindowClose(win: BrowserWindow): Promise<boolean> {
  const contents = win.webContents
  if (win.isDestroyed() || contents.isLoading() || contents.isCrashed())
    return Promise.resolve(true)
  return new Promise((resolve) => {
    const requestId = ++lastRequestId
    const settle = (approved: boolean): void => {
      pending.delete(requestId)
      contents.removeListener('render-process-gone', gone)
      contents.removeListener('destroyed', gone)
      resolve(approved)
    }
    const gone = (): void => settle(true)
    contents.once('render-process-gone', gone)
    contents.once('destroyed', gone)
    pending.set(requestId, { senderId: contents.id, settle })
    contents.send('window:confirm-close', requestId)
  })
}

export async function confirmAllWindowsClose(windows: BrowserWindow[]): Promise<boolean> {
  for (const win of windows) {
    if (!(await confirmWindowClose(win))) return false
  }
  return true
}
