import { fileURLToPath } from 'node:url'
import type { IpcMain, WebContents } from 'electron'
import {
  type ClipboardChords,
  type ClipboardEdit,
  NO_CLIPBOARD_CHORDS,
  guestClipboardEdit,
  isClipboardEdit,
  normalizeClipboardChords,
} from '../../shared/keyboard/clipboardChords'
import type { ClipboardContents } from '../../shared/types'

export interface ClipboardSnapshot {
  formats: string[]
  uriList: string
}

const NATIVE_IMAGE_FORMAT =
  /^electron application\/osclipboard;format="(public\.png|public\.tiff|Apple PNG pasteboard type|NeXT TIFF v4\.0 pasteboard type)"$/

export function isImageFormat(format: string): boolean {
  return format.startsWith('image/') || NATIVE_IMAGE_FORMAT.test(format)
}

export function filePathsFromUriList(uriList: string): string[] {
  return uriList
    .split(/\r?\n/)
    .filter((line) => line.startsWith('file://'))
    .flatMap((line) => {
      try {
        return [fileURLToPath(line)]
      } catch {
        return []
      }
    })
}

export function clipboardContents(snapshot: ClipboardSnapshot): ClipboardContents {
  return {
    files: filePathsFromUriList(snapshot.uriList),
    image: snapshot.formats.some(isImageFormat),
  }
}

export interface ClipboardEditsDeps {
  ipc: Pick<IpcMain, 'handle' | 'on'>
  isAppWindow: (sender: WebContents) => boolean
  snapshot: () => Promise<ClipboardSnapshot>
  mac: boolean
}

export interface ClipboardEdits {
  guardGuest: (guest: WebContents) => void
}

function applyClipboardEdit(target: WebContents, edit: ClipboardEdit): void {
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

  deps.ipc.handle('clipboard:contents', async (e): Promise<ClipboardContents> => {
    if (!deps.isAppWindow(e.sender)) return { files: [], image: false }
    return clipboardContents(await deps.snapshot())
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
