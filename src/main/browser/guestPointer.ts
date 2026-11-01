import type { WebContents } from 'electron'

export const GUEST_POINTER_DOWN = 'guest-input:pointer-down'

export function announceGuestPointer(guest: WebContents, owner: WebContents): void {
  guest.on('input-event', (_event, input) => {
    if (input.type === 'mouseDown' && !owner.isDestroyed())
      owner.send(GUEST_POINTER_DOWN, guest.id, Date.now())
  })
}
