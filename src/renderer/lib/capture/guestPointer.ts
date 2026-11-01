import type { WebviewTag } from 'electron'
import { closeCapture, useCaptureStore } from './captureSession'

function guestIdOf(guest: HTMLElement): number | null {
  try {
    return (guest as WebviewTag).getWebContentsId()
  } catch {
    return null
  }
}

export function closeOnGuestPointer(paneId: string, guest: HTMLElement): () => void {
  return window.ostia.guestInput.onPointerDown((guestId, at) => {
    if (guestIdOf(guest) !== guestId) return
    const open = useCaptureStore.getState().open[paneId]
    if (open && at > open.openedAt) closeCapture(paneId, 'guest-click')
  })
}
