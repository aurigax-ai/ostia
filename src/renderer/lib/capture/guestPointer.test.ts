import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeCapture, openCapture, useCaptureStore } from './captureSession'
import { closeOnGuestPointer } from './guestPointer'

const GUEST_ID = 41

let pressed: Array<(guestId: number) => void> = []

beforeEach(() => {
  pressed = []
  window.ostia = {
    guestInput: {
      onPointerDown: (cb: (guestId: number) => void) => {
        pressed.push(cb)
        return () => {
          pressed = pressed.filter((held) => held !== cb)
        }
      },
    },
  } as unknown as typeof window.ostia
})

afterEach(() => {
  closeCapture('p1', 'source-gone')
  document.body.innerHTML = ''
})

function adapter(clear = vi.fn()) {
  return {
    anchor: null,
    takeFocus: true,
    highlight: null,
    copy: vi.fn(),
    send: vi.fn(),
    clear,
  }
}

function guestElement(): HTMLElement {
  const guest = document.createElement('button')
  Object.assign(guest, { getWebContentsId: () => GUEST_ID })
  document.body.append(guest)
  return guest
}

const press = (guestId: number): void => {
  for (const cb of pressed) cb(guestId)
}

describe('closeOnGuestPointer', () => {
  it('closes the pane capture when the human presses in the page, until released', () => {
    const clear = vi.fn()
    const release = closeOnGuestPointer('p1', guestElement())
    openCapture('p1', adapter(clear))
    press(GUEST_ID)
    expect(clear).toHaveBeenCalledExactlyOnceWith('guest-click')
    expect(useCaptureStore.getState().open.p1).toBeUndefined()
    release()
    openCapture('p1', adapter())
    press(GUEST_ID)
    expect(useCaptureStore.getState().open.p1).toBeDefined()
  })

  it('never closes on the focus echo of the page taking the window focus', () => {
    const guest = guestElement()
    const release = closeOnGuestPointer('p1', guest)
    openCapture('p1', adapter())
    guest.focus()
    window.dispatchEvent(new Event('blur'))
    expect(useCaptureStore.getState().open.p1).toBeDefined()
    release()
  })

  it('ignores a press in another page', () => {
    const release = closeOnGuestPointer('p1', guestElement())
    openCapture('p1', adapter())
    press(GUEST_ID + 1)
    expect(useCaptureStore.getState().open.p1).toBeDefined()
    release()
  })
})
