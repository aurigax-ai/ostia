import type { IpcMain, WebContents } from 'electron'
import { guestChordKey, normalizeGuestChords } from '../shared/guestChords'

export interface GuestChordsDeps {
  ipc: Pick<IpcMain, 'on'>
  isAppWindow: (sender: WebContents) => boolean
  mac: boolean
}

export interface GuestChords {
  guardGuest: (guest: WebContents) => void
}

export const GUEST_CHORDS_SET = 'guest-chords:set'
export const GUEST_CHORDS_FIRE = 'guest-chords:fire'

export function registerGuestChords(deps: GuestChordsDeps): GuestChords {
  let chords: ReadonlySet<string> = new Set()

  deps.ipc.on(GUEST_CHORDS_SET, (e, raw: unknown) => {
    if (!deps.isAppWindow(e.sender)) return
    const next = normalizeGuestChords(raw, deps.mac)
    if (next) chords = new Set(next)
  })

  return {
    guardGuest: (guest) => {
      guest.on('before-input-event', (event, input) => {
        const key = guestChordKey(input, chords, deps.mac)
        if (!key) return
        const host = guest.hostWebContents
        if (!host || host.isDestroyed()) return
        event.preventDefault()
        host.send(GUEST_CHORDS_FIRE, { guestId: guest.id, key })
      })
    },
  }
}
