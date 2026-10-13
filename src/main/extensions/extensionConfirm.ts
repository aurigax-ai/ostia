import { type BrowserWindow, dialog } from 'electron'
import type { ExtensionConfirmRequest } from './extensionHost'

export async function confirmForExtension(
  req: ExtensionConfirmRequest,
  windows: Iterable<BrowserWindow>,
): Promise<boolean> {
  const all = [...windows].filter((w) => !w.isDestroyed())
  const win = all.find((w) => w.isFocused()) ?? all[0]
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: `${req.extName}: ${req.title}`,
    message: req.message,
    detail: req.detail ? `${req.detail}\n\n${req.extName}` : req.extName,
    buttons: [req.confirmLabel ?? 'OK', req.cancelLabel ?? 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  const res = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return res.response === 0
}
