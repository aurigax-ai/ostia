import type { IpcMain, WebContents } from 'electron'
import { DOUBLE_SHIFT_KEY, doubleShiftDetector } from '../../shared/keyboard/chordSpec'
import {
  guestChordKey,
  guestDoubleShift,
  isPageFindKey,
  normalizeGuestChords,
} from '../../shared/keyboard/guestChords'
import { injectInto } from './guestInject'
import type { GuestRemap } from './guestRemap'

export interface GuestChordsDeps {
  ipc: Pick<IpcMain, 'on'>
  isAppWindow: (sender: WebContents) => boolean
  mac: boolean
  remap: GuestRemap
  isHumanBrowser: (guest: WebContents) => boolean
  viewerOwnsFindKeys: (guest: WebContents) => boolean
}

export interface GuestChords {
  guardGuest: (guest: WebContents) => void
}

export const GUEST_CHORDS_SET = 'guest-chords:set'
export const GUEST_CHORDS_FIRE = 'guest-chords:fire'
export const GUEST_REMAP_SET = 'guest-chords:remap'

export function registerGuestChords(deps: GuestChordsDeps): GuestChords {
  let chords: ReadonlySet<string> = new Set()

  deps.ipc.on(GUEST_CHORDS_SET, (e, raw: unknown) => {
    if (!deps.isAppWindow(e.sender)) return
    const next = normalizeGuestChords(raw, deps.mac)
    if (next) chords = new Set(next)
  })

  deps.ipc.on(GUEST_REMAP_SET, (e, raw: unknown) => {
    if (deps.isAppWindow(e.sender)) deps.remap.set(raw)
  })

  return {
    guardGuest: (guest) => {
      guest.once('destroyed', () => deps.remap.forget(guest.id))
      const doubleShift = doubleShiftDetector()
      guest.on('before-input-event', (event, raw) => {
        const input = deps.remap.remap(guest.id, raw)
        const tapped = guestDoubleShift(input, chords, doubleShift, Date.now())
        const pageFind = isPageFindKey(input, deps.mac) && deps.viewerOwnsFindKeys(guest)
        const key = tapped
          ? DOUBLE_SHIFT_KEY
          : pageFind
            ? null
            : guestChordKey(input, chords, deps.mac)
        if (!key) return
        const host = guest.hostWebContents
        if (!host || host.isDestroyed()) return
        if (!tapped) event.preventDefault()
        host.send(GUEST_CHORDS_FIRE, { guestId: guest.id, key })
      })
      if (!deps.mac || !deps.isHumanBrowser(guest)) return
      guest.on('before-input-event', (event, raw) => {
        if (event.defaultPrevented) return
        const next = deps.remap.rewrite(guest.id, raw)
        if (!next) return
        event.preventDefault()
        injectInto(guest.id, () => {
          for (const sent of next) guest.sendInputEvent(sent)
        })
      })
    },
  }
}
