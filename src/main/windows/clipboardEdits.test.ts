import { EventEmitter } from 'node:events'
import type { IpcMain, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { parseChord } from '../../shared/keyboard/chordSpec'
import { createGuestRemap } from '../browser/guestRemap'
import {
  clipboardContents,
  clipboardItemData,
  filePathsFromUriList,
  isImageFormat,
  registerClipboardEdits,
} from './clipboardEdits'

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

const written: unknown[] = []

function setup(
  formats: string[] = [],
  mac = false,
  uriList = '',
  copyViewerSelection: (guest: WebContents) => boolean = () => false,
) {
  written.length = 0
  const app = fakeContents()
  const { ipc, call } = fakeIpc()
  const remap = createGuestRemap({ nativeMenuKey: () => false })
  const edits = registerClipboardEdits({
    ipc,
    isAppWindow: (sender) => sender === app,
    snapshot: async () => ({ formats, uriList }),
    write: async (capture) => {
      written.push(capture)
    },
    mac,
    remap,
    copyViewerSelection,
  })
  return { app, call, edits, remap }
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

  it('writes a validated capture for an app window only', async () => {
    const { app, call } = setup()
    expect(
      await call('clipboard:write-capture', app, { text: 'a,b', html: '<table></table>' }),
    ).toBe(true)
    expect(written).toEqual([{ text: 'a,b', html: '<table></table>' }])
    expect(await call('clipboard:write-capture', fakeContents(), { text: 'x' })).toBe(false)
    expect(await call('clipboard:write-capture', app, { png: new Uint8Array(12) })).toBe(false)
    expect(await call('clipboard:write-capture', app, {})).toBe(false)
    expect(written).toHaveLength(1)
  })

  it('maps a capture to one clipboard item per format', async () => {
    const data = clipboardItemData({
      text: 'a',
      html: '<b>a</b>',
      png: new Uint8Array([0x89, 0x50]),
    })
    expect(Object.keys(data)).toEqual(['text/plain', 'text/html', 'image/png'])
    expect(await data['text/plain'].text()).toBe('a')
    expect(Object.keys(clipboardItemData({ text: 'a' }))).toEqual(['text/plain'])
  })

  it('reports the clipboard contents only to an app window', async () => {
    const { app, call } = setup(['image/png'])
    expect(await call('clipboard:contents', app)).toEqual({ files: [], image: true })
    expect(await call('clipboard:contents', fakeContents())).toEqual({ files: [], image: false })
    const text = setup(['text/plain'])
    expect(await text.call('clipboard:contents', text.app)).toEqual({ files: [], image: false })
  })

  it('reports a copied file and its native image types the way Finder leaves them', async () => {
    const finder = setup(
      [
        'text/uri-list',
        'electron application/osclipboard;format="Apple PNG pasteboard type"',
        'electron application/osclipboard;format="NeXT TIFF v4.0 pasteboard type"',
      ],
      true,
      'file:///Users/me/Desktop/my%20shot.png\r\n',
    )
    expect(await finder.call('clipboard:contents', finder.app)).toEqual({
      files: ['/Users/me/Desktop/my shot.png'],
      image: true,
    })
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

  it('copies a viewer guest selection from main, and everything else natively', () => {
    const viewerGuest = fakeContents()
    const stored = new Set<WebContents>([viewerGuest])
    const copyViewerSelection = vi.fn((guest: WebContents) => stored.has(guest))
    const { app, call, edits } = setup([], false, '', copyViewerSelection)
    const page = fakeContents()
    edits.guardGuest(viewerGuest)
    edits.guardGuest(page)
    call('clipboard:set-chords', app, linuxChords)
    expect(press(viewerGuest, { control: true, shift: true }).preventDefault).toHaveBeenCalled()
    expect(copyViewerSelection).toHaveBeenCalledWith(viewerGuest)
    expect(viewerGuest.copy).not.toHaveBeenCalled()
    press(page, { control: true, shift: true })
    expect(page.copy).toHaveBeenCalledTimes(1)
    stored.clear()
    press(viewerGuest, { control: true, shift: true })
    expect(viewerGuest.copy).toHaveBeenCalledTimes(1)
    press(viewerGuest, { control: true, shift: true, key: 'V', code: 'KeyV' })
    expect(copyViewerSelection).toHaveBeenCalledTimes(3)
    expect(viewerGuest.pasteAndMatchStyle).toHaveBeenCalledTimes(1)
  })

  it('copies for a key remapped to Command, which the system menu never sees, and leaves a real Cmd+C to the page', () => {
    const { app, call, edits, remap } = setup([], true)
    const guest = fakeContents()
    edits.guardGuest(guest)
    call('clipboard:set-chords', app, {
      copy: parseChord('Cmd+C', true),
      paste: parseChord('Cmd+V', true),
    })
    remap.set({ ControlRight: 'command' })
    expect(press(guest, { meta: true }).preventDefault).not.toHaveBeenCalled()
    press(guest, { key: 'Control', code: 'ControlRight', control: true })
    expect(press(guest, { control: true }).preventDefault).toHaveBeenCalled()
    expect(guest.copy).toHaveBeenCalledTimes(1)
  })

  it('copies for Option remapped to Command on a layout where Option+C types a cedilla', () => {
    const { app, call, edits, remap } = setup([], true)
    const guest = fakeContents()
    edits.guardGuest(guest)
    call('clipboard:set-chords', app, {
      copy: parseChord('Cmd+C', true),
      paste: parseChord('Cmd+V', true),
    })
    remap.set({ AltLeft: 'command' })
    press(guest, { key: 'Alt', code: 'AltLeft', alt: true })
    expect(press(guest, { key: 'ç', alt: true }).preventDefault).toHaveBeenCalled()
    expect(guest.copy).toHaveBeenCalledTimes(1)
  })

  it('forgets the held keys of a guest that is destroyed', () => {
    const { edits, remap } = setup([], true)
    const guest = fakeContents()
    const forget = vi.spyOn(remap, 'forget')
    edits.guardGuest(guest)
    guest.emit('destroyed')
    expect(forget).toHaveBeenCalledTimes(1)
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

describe('clipboardContents', () => {
  it('sees an image in the native macOS types Electron reports when no image MIME type exists', () => {
    for (const format of [
      'electron application/osclipboard;format="public.png"',
      'electron application/osclipboard;format="public.tiff"',
      'electron application/osclipboard;format="Apple PNG pasteboard type"',
      'electron application/osclipboard;format="NeXT TIFF v4.0 pasteboard type"',
    ]) {
      expect(clipboardContents({ formats: ['text/uri-list', format], uriList: '' }).image).toBe(
        true,
      )
    }
  })

  it('does not take other raw formats or plain text for an image', () => {
    expect(isImageFormat('electron application/osclipboard;format="public.utf8-plain-text"')).toBe(
      false,
    )
    expect(isImageFormat('text/plain')).toBe(false)
    expect(clipboardContents({ formats: ['text/plain'], uriList: '' })).toEqual({
      files: [],
      image: false,
    })
  })

  it('lists every local file in the URI list and skips comments and web links', () => {
    expect(
      filePathsFromUriList(
        '# copied\r\nfile:///tmp/a%20b.png\r\nhttps://example.com/x.png\nfile:///tmp/c.txt\n',
      ),
    ).toEqual(['/tmp/a b.png', '/tmp/c.txt'])
  })

  it('skips a file URL that names another host', () => {
    expect(filePathsFromUriList('file://server/share/a.png')).toEqual([])
  })

  it('reports a file together with an image, which the renderer pastes as a path', () => {
    expect(
      clipboardContents({ formats: ['image/png', 'text/uri-list'], uriList: 'file:///tmp/a.png' }),
    ).toEqual({ files: ['/tmp/a.png'], image: true })
  })
})
