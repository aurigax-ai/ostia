import type { IpcMain, WebContents } from 'electron'
import {
  type ClipboardChords,
  type ClipboardEdit,
  NO_CLIPBOARD_CHORDS,
  guestClipboardEdit,
  isClipboardEdit,
  normalizeClipboardChords,
} from '../shared/clipboardChords'

export interface ClipboardEditsDeps {
  ipc: Pick<IpcMain, 'handle' | 'on'>
  isAppWindow: (sender: WebContents) => boolean
  availableFormats: () => Promise<string[]>
  mac: boolean
}

export interface ClipboardEdits {
  guardGuest: (guest: WebContents) => void
}

export function applyClipboardEdit(target: WebContents, edit: ClipboardEdit): void {
  if (edit === 'copy') target.copy()
  else target.pasteAndMatchStyle()
}

export function registerClipboardEdits(deps: ClipboardEditsDeps): ClipboardEdits {
  let chords: ClipboardChords = NO_CLIPBOARD_CHORDS

  deps.ipc.on('clipboard:set-chords', (e, raw: unknown) => {
    if (!deps.isAppWindow(e.sender)) return
    const next = normalizeClipboardChords(raw, deps.mac)
    if (next) chords = next
  })

  deps.ipc.handle('clipboard:edit', (e, edit: unknown) => {
    if (!deps.isAppWindow(e.sender) || !isClipboardEdit(edit)) return
    applyClipboardEdit(e.sender, edit)
  })

  deps.ipc.handle('clipboard:has-image', async (e) => {
    if (!deps.isAppWindow(e.sender)) return false
    return (await deps.availableFormats()).some((format) => format.startsWith('image/'))
  })

  return {
    guardGuest: (guest) => {
      guest.on('before-input-event', (event, input) => {
        const edit = guestClipboardEdit(input, chords, deps.mac)
        if (!edit) return
        event.preventDefault()
        applyClipboardEdit(guest, edit)
      })
    },
  }
}
