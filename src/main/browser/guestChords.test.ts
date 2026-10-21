import { EventEmitter } from 'node:events'
import type { IpcMain, KeyboardInputEvent, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  GUEST_CHORDS_FIRE,
  GUEST_CHORDS_SET,
  GUEST_REMAP_SET,
  registerGuestChords,
} from './guestChords'
import { createGuestRemap } from './guestRemap'

type Handler = (event: { sender: WebContents }, ...args: unknown[]) => unknown

function setup(mac = false, humanBrowser = true, ownsFind = false) {
  const handlers = new Map<string, Handler>()
  const ipc = {
    on: (channel: string, fn: Handler) => handlers.set(channel, fn),
  } as unknown as Pick<IpcMain, 'on'>
  const app = { id: 1 } as unknown as WebContents
  const host = { send: vi.fn(), isDestroyed: () => false }
  const guest = Object.assign(new EventEmitter(), {
    id: 9,
    hostWebContents: host,
    sendInputEvent: vi.fn(),
  }) as unknown as WebContents & EventEmitter
  const chords = registerGuestChords({
    ipc,
    isAppWindow: (s) => s === app,
    mac,
    remap: createGuestRemap({ nativeMenuKey: (input) => input.key === 'q' && input.meta }),
    isHumanBrowser: () => humanBrowser,
    viewerOwnsFindKeys: () => ownsFind,
  })
  chords.guardGuest(guest)
  const set = (sender: WebContents, value: unknown) =>
    handlers.get(GUEST_CHORDS_SET)?.({ sender }, value)
  const press = (input: Record<string, unknown>) => {
    const event = {
      defaultPrevented: false,
      preventDefault: vi.fn(() => {
        event.defaultPrevented = true
      }),
    }
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
  const remap = (sender: WebContents, value: unknown) =>
    handlers.get(GUEST_REMAP_SET)?.({ sender }, value)
  return { app, host, guest, set, press, remap }
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

  it('leaves the find keys to a viewer page that owns find and still forwards its other app chords', () => {
    const { app, host, set, press } = setup(false, true, true)
    set(app, ['Ctrl+F', 'Ctrl+G', 'Ctrl+Shift+P'])
    const find = press({ key: 'f', code: 'KeyF', shift: false })
    expect(find.preventDefault).not.toHaveBeenCalled()
    expect(press({ key: 'g', code: 'KeyG', shift: true }).preventDefault).not.toHaveBeenCalled()
    expect(host.send).not.toHaveBeenCalled()
    expect(press({}).preventDefault).toHaveBeenCalled()
    expect(host.send).toHaveBeenCalledTimes(1)
  })

  it('forwards the find keys of a viewer page that did not claim them, like any other guest', () => {
    const { app, host, set, press } = setup(false, true, false)
    set(app, ['Ctrl+F', 'Ctrl+G'])
    expect(press({ key: 'f', code: 'KeyF', shift: false }).preventDefault).toHaveBeenCalled()
    expect(press({ key: 'g', code: 'KeyG', shift: false }).preventDefault).toHaveBeenCalled()
    expect(host.send).toHaveBeenCalledTimes(2)
  })

  it('forwards the find keys of any other guest to the host window', () => {
    const { app, host, set, press } = setup()
    set(app, ['Ctrl+F'])
    expect(press({ key: 'f', code: 'KeyF', shift: false }).preventDefault).toHaveBeenCalled()
    expect(host.send).toHaveBeenCalledTimes(1)
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

  it('tells the host about two quick Shift taps without holding the keys back from the page', () => {
    vi.useFakeTimers({ now: 0 })
    try {
      const { app, host, set, press } = setup(true)
      set(app, ['Shift+Shift'])
      const tap = (at: number) => {
        vi.setSystemTime(at)
        const shift = { key: 'Shift', code: 'ShiftLeft', control: false, shift: true }
        const down = press(shift)
        vi.setSystemTime(at + 50)
        const up = press({ ...shift, type: 'keyUp' })
        return [down, up]
      }
      const events = [...tap(0), ...tap(150)]
      for (const event of events) expect(event.preventDefault).not.toHaveBeenCalled()
      expect(host.send).toHaveBeenCalledTimes(1)
      expect(host.send).toHaveBeenCalledWith(GUEST_CHORDS_FIRE, {
        guestId: 9,
        key: {
          key: 'Shift',
          code: 'ShiftLeft',
          ctrlKey: false,
          metaKey: false,
          shiftKey: true,
          altKey: false,
        },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does nothing when the host window is gone', () => {
    const { app, guest, set, press } = setup()
    set(app, ['Ctrl+Shift+P'])
    Object.assign(guest, { hostWebContents: null })
    expect(press({}).preventDefault).not.toHaveBeenCalled()
  })

  it('matches a chord on the keys the remap makes of the held ones, and nothing for a stranger', () => {
    const { app, host, set, press, remap } = setup(true)
    set(app, ['Cmd+K'])
    const ctrlK = { key: 'k', code: 'KeyK', control: true, shift: false }
    const hold = { key: 'Control', code: 'ControlRight', control: true, shift: false }
    remap({ id: 2 } as unknown as WebContents, { ControlRight: 'command' })
    press(hold)
    expect(press(ctrlK).preventDefault).not.toHaveBeenCalled()
    remap(app, { ControlRight: 'command' })
    const event = press(ctrlK)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(host.send).toHaveBeenCalledWith(GUEST_CHORDS_FIRE, {
      guestId: 9,
      key: {
        key: 'k',
        code: 'KeyK',
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: true,
      },
    })
  })

  it('lets the page keep a real Cmd+C but treats a key remapped to Command as an app chord', () => {
    const { app, host, set, press, remap } = setup(true)
    set(app, ['Cmd+C'])
    const cmdC = { key: 'c', code: 'KeyC', control: false, shift: false, meta: true }
    expect(press(cmdC).preventDefault).not.toHaveBeenCalled()
    remap(app, { ControlLeft: 'command' })
    press({ key: 'Control', code: 'ControlLeft', control: true, shift: false })
    const event = press({ key: 'c', code: 'KeyC', control: true, shift: false })
    expect(event.preventDefault).toHaveBeenCalled()
    expect(host.send).toHaveBeenCalledTimes(1)
  })

  it('matches Cmd+C for Option remapped to Command although Option+C types a cedilla', () => {
    const { app, host, set, press, remap } = setup(true)
    set(app, ['Cmd+C'])
    remap(app, { AltLeft: 'command' })
    press({ key: 'Alt', code: 'AltLeft', control: false, shift: false, alt: true })
    const event = press({ key: 'ç', code: 'KeyC', control: false, shift: false, alt: true })
    expect(event.preventDefault).toHaveBeenCalled()
    expect(host.send).toHaveBeenCalledWith(GUEST_CHORDS_FIRE, {
      guestId: 9,
      key: {
        key: 'ç',
        code: 'KeyC',
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: true,
      },
    })
  })

  it('cancels a physical key a remap changes and sends the remapped one to the page', () => {
    const { app, guest, press, remap } = setup(true)
    remap(app, { ControlLeft: 'command' })
    const sent = vi.mocked(guest.sendInputEvent)
    const hold = press({ key: 'Control', code: 'ControlLeft', control: true, shift: false })
    expect(hold.preventDefault).toHaveBeenCalled()
    expect(sent).toHaveBeenLastCalledWith({ type: 'keyDown', keyCode: 'Meta', modifiers: ['meta'] })
    const event = press({ key: 'k', code: 'KeyK', control: true, shift: false })
    expect(event.preventDefault).toHaveBeenCalled()
    expect(sent).toHaveBeenLastCalledWith({ type: 'keyDown', keyCode: 'K', modifiers: ['meta'] })
  })

  it('leaves a key alone with no remap set', () => {
    const { guest, press } = setup(true)
    expect(press({ key: 'k', code: 'KeyK', control: true }).preventDefault).not.toHaveBeenCalled()
    expect(guest.sendInputEvent).not.toHaveBeenCalled()
  })

  it('sends nothing to the page off macOS', () => {
    const { app, guest, press, remap } = setup(false)
    remap(app, { ControlLeft: 'command' })
    press({ key: 'Control', code: 'ControlLeft', control: true, shift: false })
    expect(guest.sendInputEvent).not.toHaveBeenCalled()
  })

  it('leaves the keys of a page that is not the human browser alone', () => {
    const { app, guest, press, remap } = setup(true, false)
    remap(app, { ControlLeft: 'command' })
    expect(
      press({ key: 'Control', code: 'ControlLeft', control: true }).preventDefault,
    ).not.toHaveBeenCalled()
    expect(guest.sendInputEvent).not.toHaveBeenCalled()
  })

  it('does not send a key an app chord already took', () => {
    const { app, guest, set, press, remap } = setup(true)
    set(app, ['Cmd+K'])
    remap(app, { ControlLeft: 'command' })
    press({ key: 'Control', code: 'ControlLeft', control: true, shift: false })
    vi.mocked(guest.sendInputEvent).mockClear()
    press({ key: 'k', code: 'KeyK', control: true, shift: false })
    expect(guest.sendInputEvent).not.toHaveBeenCalled()
  })

  it('does not remap the event it sent itself a second time', () => {
    const { app, guest, press, remap } = setup(true)
    remap(app, { ControlLeft: 'command', MetaLeft: 'control' })
    const sent = vi.mocked(guest.sendInputEvent)
    sent.mockImplementation((raw) => {
      const event = raw as KeyboardInputEvent
      press({
        type: event.type,
        key: event.keyCode.toLowerCase(),
        code: event.keyCode === 'Meta' ? 'MetaLeft' : 'KeyK',
        control: event.modifiers?.includes('control'),
        meta: event.modifiers?.includes('meta'),
      })
    })
    press({ key: 'Control', code: 'ControlLeft', control: true, shift: false })
    press({ key: 'k', code: 'KeyK', control: true, shift: false })
    expect(sent).toHaveBeenCalledTimes(2)
    expect(sent).toHaveBeenLastCalledWith({ type: 'keyDown', keyCode: 'K', modifiers: ['meta'] })
  })
})
