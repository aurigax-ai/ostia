import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeCapture, openCapture, useCaptureStore } from './captureSession'
import { closeOnGuestFocus } from './guestFocus'

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

describe('closeOnGuestFocus', () => {
  it('closes the pane capture when the page takes the focus from the window, until released', () => {
    const clear = vi.fn()
    const guest = document.createElement('button')
    document.body.append(guest)
    const release = closeOnGuestFocus('p1', guest)
    openCapture('p1', adapter(clear))
    guest.focus()
    window.dispatchEvent(new Event('blur'))
    expect(clear).toHaveBeenCalledExactlyOnceWith('guest-focus')
    expect(useCaptureStore.getState().open.p1).toBeUndefined()
    release()
    openCapture('p1', adapter())
    window.dispatchEvent(new Event('blur'))
    expect(useCaptureStore.getState().open.p1).toBeDefined()
  })

  it('never closes when the window loses the focus with the page not holding it', () => {
    const guest = document.createElement('button')
    document.body.append(guest)
    const release = closeOnGuestFocus('p1', guest)
    openCapture('p1', adapter())
    window.dispatchEvent(new Event('blur'))
    expect(useCaptureStore.getState().open.p1).toBeDefined()
    release()
  })
})
