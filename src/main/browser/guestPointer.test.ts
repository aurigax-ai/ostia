import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { announceGuestPointer, GUEST_POINTER_DOWN } from './guestPointer'

function setup() {
  const guest = Object.assign(new EventEmitter(), { id: 7 })
  const owner = { send: vi.fn(), isDestroyed: () => false }
  announceGuestPointer(guest as unknown as WebContents, owner as unknown as WebContents)
  return { guest, owner }
}

describe('announceGuestPointer', () => {
  it('tells the owner window which guest the human pressed in', () => {
    const { guest, owner } = setup()
    guest.emit('input-event', {}, { type: 'mouseDown' })
    expect(owner.send).toHaveBeenCalledExactlyOnceWith(GUEST_POINTER_DOWN, 7, expect.any(Number))
  })

  it('stays quiet for moves, releases and keys', () => {
    const { guest, owner } = setup()
    for (const type of ['mouseMove', 'mouseUp', 'keyDown', 'mouseWheel']) {
      guest.emit('input-event', {}, { type })
    }
    expect(owner.send).not.toHaveBeenCalled()
  })
})
