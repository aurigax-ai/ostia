import { fileURLToPath } from 'node:url'
import type { IpcMain, WebContents } from 'electron'
import type { ClipboardContents } from '../../shared/app/appApi'
import {
  type ClipboardCapture,
  normalizeClipboardCapture,
} from '../../shared/keyboard/clipboardCapture'
import {
  type ClipboardChords,
  type ClipboardEdit,
  guestClipboardEdit,
  isClipboardEdit,
  NO_CLIPBOARD_CHORDS,
  normalizeClipboardChords,
} from '../../shared/keyboard/clipboardChords'
import type { GuestRemap } from '../browser/guestRemap'

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

export function clipboardItemData(capture: ClipboardCapture): Record<string, Blob> {
  const data: Record<string, Blob> = {}
  if (capture.text !== undefined) data['text/plain'] = new Blob([capture.text])
  if (capture.html !== undefined) data['text/html'] = new Blob([capture.html])
  if (capture.png) data['image/png'] = new Blob([new Uint8Array(capture.png)])
  return data
}

export interface ClipboardEditsDeps {
  ipc: Pick<IpcMain, 'handle' | 'on'>
  isAppWindow: (sender: WebContents) => boolean
  snapshot: () => Promise<ClipboardSnapshot>
  write: (capture: ClipboardCapture) => Promise<void>
  mac: boolean
  remap: GuestRemap
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

  deps.ipc.handle('clipboard:write-capture', async (e, raw: unknown): Promise<boolean> => {
    if (!deps.isAppWindow(e.sender)) return false
    const capture = normalizeClipboardCapture(raw)
    if (!capture) return false
    await deps.write(capture)
    return true
  })

  deps.ipc.handle('clipboard:contents', async (e): Promise<ClipboardContents> => {
    if (!deps.isAppWindow(e.sender)) return { files: [], image: false }
    return clipboardContents(await deps.snapshot())
  })

  return {
    guardGuest: (guest) => {
      guest.once('destroyed', () => deps.remap.forget(guest.id))
      guest.on('before-input-event', (event, raw) => {
        const edit = guestClipboardEdit(deps.remap.remap(guest.id, raw), chords, deps.mac)
        if (!edit) return
        event.preventDefault()
        applyClipboardEdit(guest, edit)
      })
    },
  }
}
