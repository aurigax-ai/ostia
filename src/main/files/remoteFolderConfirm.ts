import type { RemoteFolderAsk } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { type BrowserWindow, ipcMain } from 'electron'
import { answerPending, ask as askWindow } from '../windows/closeGuard'

export function registerRemoteFolderConfirm(): void {
  ipcMain.on('remote-files:confirm-answer', (e, requestId: unknown, approved: unknown) => {
    if (typeof requestId === 'number') answerPending(e.sender.id, requestId, approved)
  })
}

export async function confirmRemoteFolder(
  win: BrowserWindow | undefined,
  ask: RemoteFolderAsk,
): Promise<boolean> {
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  win.focus()
  return (await askWindow(win, 'remote-files:confirm', ask, false)) === true
}
