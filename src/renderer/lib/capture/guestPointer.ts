import type { WebviewTag } from 'electron'
import { closeCapture } from './captureSession'

function guestIdOf(guest: HTMLElement): number | null {
  try {
    return (guest as WebviewTag).getWebContentsId()
  } catch {
    return null
  }
}

export function closeOnGuestPointer(paneId: string, guest: HTMLElement): () => void {
  return window.ostia.guestInput.onPointerDown((guestId) => {
    if (guestIdOf(guest) === guestId) closeCapture(paneId, 'guest-click')
  })
}
