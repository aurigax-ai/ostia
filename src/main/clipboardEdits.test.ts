import { EventEmitter } from 'node:events'
import type { IpcMain, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { parseChord } from '../shared/chordSpec'
import { registerClipboardEdits } from './clipboardEdits'

type Handler = (event: { sender: WebContents }, ...args: unknown[]) => unknown

function fakeIpc() {
  const handlers = new Map<string, Handler>()
  const ipc = {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    on: (channel: string, fn: Handler) => handlers.set(channel, fn),
  } as unknown as Pick<IpcMain, 'handle' | 'on'>
  const call = (channel: string, sender: WebContents, ...args: unknown[]) =>
    handlers.get(channel)?.({ sender }, ...args)
  return { ipc, call }
}

function fakeContents(): WebContents & EventEmitter {
  return Object.assign(new EventEmitter(), {
    copy: vi.fn(),
    pasteAndMatchStyle: vi.fn(),
  }) as unknown as WebContents & EventEmitter
}

const linuxChords = {
  copy: parseChord('Ctrl+Shift+C', false),
  paste: parseChord('Ctrl+Shift+V', false),
}

function setup(formats: string[] = [], mac = false) {
  const app = fakeContents()
  const { ipc, call } = fakeIpc()
  const edits = registerClipboardEdits({
    ipc,
    isAppWindow: (sender) => sender === app,
    availableFormats: async () => formats,
    mac,
  })
  return { app, call, edits }
}

function press(guest: EventEmitter, input: Record<string, unknown>) {
  const event = { preventDefault: vi.fn() }
  guest.emit('before-input-event', event, {
    type: 'keyDown',
    key: 'c',
    code: 'KeyC',
    control: false,
    shift: false,
    alt: false,
    meta: false,
    ...input,
  })
  return event
}

describe('registerClipboardEdits', () => {
  it('copies and pastes on the sender only, for an app window and a known edit', () => {
    const { app, call } = setup()
    call('clipboard:edit', app, 'copy')
    call('clipboard:edit', app, 'paste')
    call('clipboard:edit', app, 'selectAll')
    expect(app.copy).toHaveBeenCalledTimes(1)
    expect(app.pasteAndMatchStyle).toHaveBeenCalledTimes(1)
    const stranger = fakeContents()
    call('clipboard:edit', stranger, 'paste')
    expect(stranger.pasteAndMatchStyle).not.toHaveBeenCalled()
  })

  it('reports an image on the clipboard only to an app window', async () => {
    const { app, call } = setup(['image/png'])
    expect(await call('clipboard:has-image', app)).toBe(true)
    expect(await call('clipboard:has-image', fakeContents())).toBe(false)
    const text = setup(['text/plain'])
    expect(await text.call('clipboard:has-image', text.app)).toBe(false)
  })

  it('runs the chords the renderer sent inside a guest page', () => {
    const { app, call, edits } = setup()
    const guest = fakeContents()
    edits.guardGuest(guest)
    expect(press(guest, { control: true, shift: true }).preventDefault).not.toHaveBeenCalled()
    call('clipboard:set-chords', app, linuxChords)
    expect(press(guest, { control: true, shift: true }).preventDefault).toHaveBeenCalled()
    expect(guest.copy).toHaveBeenCalledTimes(1)
    press(guest, { control: true, shift: true, key: 'V', code: 'KeyV' })
    expect(guest.pasteAndMatchStyle).toHaveBeenCalledTimes(1)
    expect(press(guest, { control: true }).preventDefault).not.toHaveBeenCalled()
  })

  it('ignores chords from a stranger or a payload that would steal a terminal key', () => {
    const { app, call, edits } = setup()
    const guest = fakeContents()
    edits.guardGuest(guest)
    call('clipboard:set-chords', fakeContents(), linuxChords)
    call('clipboard:set-chords', app, {
      copy: { ctrl: true, shift: false, alt: false, meta: false, key: 'c' },
      paste: null,
    })
    press(guest, { control: true })
    press(guest, { control: true, shift: true })
    expect(guest.copy).not.toHaveBeenCalled()
  })

  it('keeps the chords it already had when a later payload is rejected', () => {
    const { app, call, edits } = setup()
    const guest = fakeContents()
    edits.guardGuest(guest)
    call('clipboard:set-chords', app, linuxChords)
    call('clipboard:set-chords', app, {
      copy: { ctrl: true, shift: false, alt: false, meta: false, key: 'c' },
      paste: null,
    })
    call('clipboard:set-chords', app, 'nonsense')
    call('clipboard:set-chords', fakeContents(), { copy: null, paste: null })
    expect(press(guest, { control: true, shift: true }).preventDefault).toHaveBeenCalled()
    expect(guest.copy).toHaveBeenCalledTimes(1)
    expect(press(guest, { control: true }).preventDefault).not.toHaveBeenCalled()
  })

  it('leaves Cmd+C and Cmd+V native in a guest on macOS even when sent as chords', () => {
    const { app, call, edits } = setup([], true)
    const guest = fakeContents()
    edits.guardGuest(guest)
    call('clipboard:set-chords', app, {
      copy: parseChord('Cmd+C', true),
      paste: parseChord('Cmd+V', true),
    })
    const copy = press(guest, { meta: true })
    const paste = press(guest, { meta: true, key: 'v', code: 'KeyV' })
    expect(copy.preventDefault).not.toHaveBeenCalled()
    expect(paste.preventDefault).not.toHaveBeenCalled()
    expect(guest.copy).not.toHaveBeenCalled()
    expect(guest.pasteAndMatchStyle).not.toHaveBeenCalled()
  })
})
