import { type BrowserWindow, ipcMain } from 'electron'
import type { RemoteFolderAsk } from '../shared/remoteFolders'

interface Pending {
  senderId: number
  settle: (approved: boolean) => void
}

let lastRequestId = 0
const pending = new Map<number, Pending>()

export function registerRemoteFolderConfirm(): void {
  ipcMain.on('remote-files:confirm-answer', (e, requestId: unknown, approved: unknown) => {
    const waiting = typeof requestId === 'number' ? pending.get(requestId) : undefined
    if (waiting && waiting.senderId === e.sender.id) waiting.settle(approved === true)
  })
}

export function confirmRemoteFolder(
  win: BrowserWindow | undefined,
  ask: RemoteFolderAsk,
): Promise<boolean> {
  if (!win || win.isDestroyed() || win.webContents.isLoading() || win.webContents.isCrashed()) {
    return Promise.resolve(false)
  }
  const contents = win.webContents
  return new Promise((resolve) => {
    const requestId = ++lastRequestId
    const settle = (approved: boolean): void => {
      pending.delete(requestId)
      contents.removeListener('render-process-gone', onGone)
      contents.removeListener('destroyed', onGone)
      resolve(approved)
    }
    const onGone = (): void => settle(false)
    contents.once('render-process-gone', onGone)
    contents.once('destroyed', onGone)
    pending.set(requestId, { senderId: contents.id, settle })
    if (win.isMinimized()) win.restore()
    win.focus()
    contents.send('remote-files:confirm', requestId, ask)
  })
}
