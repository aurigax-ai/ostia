import type { WebContents } from 'electron'

export const GUEST_POINTER_DOWN = 'guest-input:pointer-down'

export function announceGuestPointer(guest: WebContents, owner: WebContents): void {
  guest.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseDown' && !owner.isDestroyed())
      owner.send(GUEST_POINTER_DOWN, guest.id, Date.now())
  })
}
