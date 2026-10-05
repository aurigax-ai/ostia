import { EventEmitter } from 'node:events'
import type { IpcMain, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { GUEST_CHORDS_FIRE, GUEST_CHORDS_SET, registerGuestChords } from './guestChords'

type Handler = (event: { sender: WebContents }, ...args: unknown[]) => unknown

function setup(mac = false) {
  const handlers = new Map<string, Handler>()
  const ipc = {
    on: (channel: string, fn: Handler) => handlers.set(channel, fn),
  } as unknown as Pick<IpcMain, 'on'>
  const app = { id: 1 } as unknown as WebContents
  const host = { send: vi.fn(), isDestroyed: () => false }
  const guest = Object.assign(new EventEmitter(), {
    id: 9,
    hostWebContents: host,
  }) as unknown as WebContents & EventEmitter
  const chords = registerGuestChords({ ipc, isAppWindow: (s) => s === app, mac })
  chords.guardGuest(guest)
  const set = (sender: WebContents, value: unknown) =>
    handlers.get(GUEST_CHORDS_SET)?.({ sender }, value)
  const press = (input: Record<string, unknown>) => {
    const event = { preventDefault: vi.fn() }
    guest.emit('before-input-event', event, {
      type: 'keyDown',
      key: 'p',
      code: 'KeyP',
      control: true,
      shift: true,
      alt: false,
      meta: false,
      ...input,
    })
    return event
  }
  return { app, host, guest, set, press }
}

describe('registerGuestChords', () => {
  it('sends a bound chord to the host window instead of the page', () => {
    const { app, host, set, press } = setup()
    set(app, ['Ctrl+Shift+P'])
    const event = press({})
    expect(event.preventDefault).toHaveBeenCalled()
    expect(host.send).toHaveBeenCalledWith(GUEST_CHORDS_FIRE, {
      guestId: 9,
      key: { key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false },
    })
  })

  it('lets other keys reach the page', () => {
    const { app, host, set, press } = setup()
    set(app, ['Ctrl+Shift+P'])
    expect(press({ key: 'q', code: 'KeyQ' }).preventDefault).not.toHaveBeenCalled()
    expect(press({ type: 'keyUp' }).preventDefault).not.toHaveBeenCalled()
    expect(host.send).not.toHaveBeenCalled()
  })

  it('takes the chord list only from an app window and only when it is valid', () => {
    const { app, set, press } = setup()
    set({ id: 2 } as unknown as WebContents, ['Ctrl+Shift+P'])
    expect(press({}).preventDefault).not.toHaveBeenCalled()
    set(app, ['Ctrl+Shift+P'])
    set(app, 'garbage')
    expect(press({}).preventDefault).toHaveBeenCalled()
  })

  it('does nothing when the host window is gone', () => {
    const { app, guest, set, press } = setup()
    set(app, ['Ctrl+Shift+P'])
    Object.assign(guest, { hostWebContents: null })
    expect(press({}).preventDefault).not.toHaveBeenCalled()
  })
})
