import { type BrowserWindow, dialog } from 'electron'
import type { DiscardPrompt } from './commands'

export async function confirmDiscard(
  prompt: DiscardPrompt,
  windows: Iterable<BrowserWindow>,
): Promise<boolean> {
  const all = [...windows].filter((w) => !w.isDestroyed())
  const win = all.find((w) => w.isFocused()) ?? all[0]
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: prompt.title,
    message: prompt.message,
    detail: prompt.detail,
    buttons: [prompt.confirmLabel, prompt.cancelLabel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  const res = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return res.response === 0
}
