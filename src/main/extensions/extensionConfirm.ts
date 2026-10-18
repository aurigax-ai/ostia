import { type BrowserWindow, dialog } from 'electron'
import type { Dict } from '../../shared/app/dict'
import type { ExtensionConfirmRequest } from './extensionRuns'

export async function confirmForExtension(
  req: ExtensionConfirmRequest,
  windows: Iterable<BrowserWindow>,
  text: Dict['native']['extensionConfirm'],
): Promise<boolean> {
  const all = [...windows].filter((w) => !w.isDestroyed())
  const win = all.find((w) => w.isFocused()) ?? all[0]
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: `${req.extName}: ${req.title}`,
    message: req.message,
    detail: req.detail ? `${req.detail}\n\n${req.extName}` : req.extName,
    buttons: [req.confirmLabel ?? text.ok, req.cancelLabel ?? text.cancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  const res = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return res.response === 0
}
