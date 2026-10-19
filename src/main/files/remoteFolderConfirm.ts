import type { RemoteFolderAsk } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import type { BrowserWindow } from 'electron'
import { answersOn, ask as askWindow } from '../windows/closeGuard'

export function registerRemoteFolderConfirm(): void {
  answersOn('remote-files:confirm-answer')
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
