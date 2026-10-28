import { describe, expect, it, vi } from 'vitest'
import { GESTURE_WINDOW_MS, viewerOwner } from './viewerHost'
import {
  adoptGuest,
  FILE,
  FRAME,
  get,
  OPEN,
  pngOf,
  postSelection,
  RECT,
  selectionBody,
  setup,
} from './viewerHostHarness'

const IMAGE = {
  kind: 'image',
  imageWidth: 40,
  imageHeight: 30,
  region: { x: 1, y: 2, width: 3, height: 4 },
}
const SESSION = 'ostia-viewer-office'

async function opened(overrides = {}) {
  const harness = setup(overrides)
  const result = harness.host.open('w1', OPEN)
  if (!result.ok) throw new Error('not opened')
  const session = harness.sessions.get(SESSION)
  const guest = adoptGuest(harness.host, session, result.src)
  const click = (): boolean => guest.emit('input-event', {}, { type: 'mouseDown' })
  click()
  return { ...harness, session, src: result.src, guest, click }
}

describe('guest selection channel', () => {
  it('keeps a validated selection, fills the file from the token and tells the owner window only', async () => {
    const { session, events } = await opened()
    const body = await selectionBody(
      { capture: { ...IMAGE, file: '/etc/passwd' }, rect: RECT, frame: FRAME },
      pngOf(40, 30),
    )
    expect((await postSelection(session, body)).status).toBe(204)
    expect(events).toEqual([
      {
        windowId: 'w1',
        type: 'selection',
        payload: {
          paneId: 'p1',
          selection: {
            capture: { ...IMAGE, file: FILE },
            hasImage: true,
            hasText: false,
            anchor: { left: 10, top: 20, bottom: 60 },
            seq: 1,
          },
        },
      },
    ])
  })

  it('clamps the rect to the frame', async () => {
    const { session, events } = await opened()
    const rect = { x: -50, y: 5000, width: 1e9, height: 1e9 }
    await postSelection(
      session,
      await selectionBody({ capture: IMAGE, rect, frame: FRAME }, pngOf(4, 4)),
    )
    expect(events[0].payload).toMatchObject({
      selection: { anchor: { left: 0, top: 600, bottom: 600 } },
    })
    const wide = { x: 700, y: 100, width: 1e9, height: 1e9 }
    await postSelection(
      session,
      await selectionBody({ capture: IMAGE, rect: wide, frame: FRAME }, pngOf(4, 4)),
    )
    expect(events[1].payload).toMatchObject({
      selection: { anchor: { left: 700, top: 100, bottom: 600 } },
    })
  })

  it('refuses what a guest may not publish or what breaks a cap', async () => {
    const { session, events } = await opened()
    const send = async (meta: unknown, png: Uint8Array | null = null) =>
      (await postSelection(session, await selectionBody(meta, png))).status
    const base = { rect: RECT, frame: FRAME }
    expect(await send({ ...base, capture: { kind: 'terminal', text: 'x' } })).toBe(400)
    expect(await send({ ...base, capture: { kind: 'preview-error', count: 1, text: 'x' } })).toBe(
      400,
    )
    expect(await send({ ...base, capture: IMAGE })).toBe(400)
    expect(await send({ ...base, capture: IMAGE }, new Uint8Array(64))).toBe(400)
    expect(await send({ ...base, capture: IMAGE }, pngOf(0, 5))).toBe(400)
    expect(await send({ ...base, capture: IMAGE }, pngOf(40_000, 5))).toBe(400)
    expect(await send({ ...base, capture: IMAGE }, pngOf(5, 5, 25 * 1024 * 1024))).toBe(400)
    const text = { kind: 'text', view: 'preview', range: { startLine: 1, endLine: 2 } }
    expect(await send({ ...base, capture: text })).toBe(400)
    expect(await send({ ...base, capture: text, text: 'x'.repeat(256 * 1024 + 1) })).toBe(400)
    expect(await send({ ...base, capture: text, text: 'ok', rect: { x: 'a' } })).toBe(400)
    const cells = { kind: 'cells', sheet: 'S', range: 'A1:C3', rows: 3, columns: 3 }
    expect(await send({ ...base, capture: cells })).toBe(400)
    expect(await send({ ...base, capture: { ...cells, rows: 101, columns: 100 }, csv: 'a' })).toBe(
      400,
    )
    expect(await send({ ...base, capture: { ...cells, range: 'not a range' }, csv: 'a' })).toBe(400)
    expect(await send({ ...base, capture: cells, csv: 'x'.repeat(256 * 1024 + 1) })).toBe(400)
    expect((await postSelection(session, new Uint8Array([1, 2]))).status).toBe(400)
    expect(
      (
        await postSelection(session, new Uint8Array(1), {
          'content-length': String(60 * 1024 * 1024),
        })
      ).status,
    ).toBe(413)
    expect(events).toEqual([])
  })

  it('accepts cells, text and pdf selections with their caps', async () => {
    const { session, events } = await opened()
    const base = { rect: RECT, frame: FRAME }
    const cells = { kind: 'cells', sheet: 'S', range: 'A1:B2', rows: 2, columns: 2 }
    expect(
      (
        await postSelection(
          session,
          await selectionBody({ ...base, capture: cells, csv: 'a,b\n1,2' }),
        )
      ).status,
    ).toBe(204)
    const text = { kind: 'text', view: 'preview', range: { startLine: 3, endLine: 4 } }
    expect(
      (await postSelection(session, await selectionBody({ ...base, capture: text, text: 'hello' })))
        .status,
    ).toBe(204)
    const pdf = { kind: 'pdf-region', page: 1, pageWidth: 600, pageHeight: 800, region: null }
    expect(
      (
        await postSelection(
          session,
          await selectionBody({ ...base, capture: pdf, text: 'abc' }, pngOf(9, 9)),
        )
      ).status,
    ).toBe(204)
    expect(
      events.map(
        (e) =>
          (
            e.payload as {
              selection: { capture: { kind: string }; hasText: boolean; hasImage: boolean }
            }
          ).selection,
      ),
    ).toMatchObject([
      { capture: { kind: 'cells', csv: 'a,b\n1,2', file: FILE }, hasText: true, hasImage: false },
      { capture: { kind: 'text', view: 'preview', text: 'hello' }, hasText: true, hasImage: false },
      { capture: { kind: 'pdf-region', text: 'abc' }, hasText: true, hasImage: true },
    ])
  })

  it('clears the selection on DELETE, on close and when the viewer ends', async () => {
    const { host, session, events } = await opened()
    const body = await selectionBody({ capture: IMAGE, rect: RECT, frame: FRAME }, pngOf(4, 4))
    await postSelection(session, body)
    await get(session, 'ostia-viewer://t1/~selection', { method: 'DELETE' })
    expect(events.at(-1)).toMatchObject({
      type: 'selection',
      payload: { paneId: 'p1', selection: null },
    })
    expect(host.selectionForSend('w1', 'p1')).toBeNull()
    await postSelection(session, body)
    expect(events).toHaveLength(3)
    host.close('w1', 'p1')
    expect(events.at(-1)).toMatchObject({ payload: { selection: null } })
    expect(host.selectionForSend('w1', 'p1')).toBeNull()
    await get(session, 'ostia-viewer://t1/~selection', { method: 'DELETE' })
    expect(events).toHaveLength(4)
  })

  it('drops the stored selection when the owner window clears it and tells the page', async () => {
    const { host, session, events } = await opened()
    const body = await selectionBody({ capture: IMAGE, rect: RECT, frame: FRAME }, pngOf(4, 4))
    await postSelection(session, body)
    const stream = await get(session, 'ostia-viewer://t1/~events')
    const reader = stream.body?.getReader()
    if (!reader) throw new Error('no stream')
    await reader.read()
    host.clearSelection('w2', 'p1')
    host.clearSelection('w1', 'p9')
    expect(host.selectionForSend('w1', 'p1')).not.toBeNull()
    host.clearSelection('w1', 'p1')
    expect(host.selectionForSend('w1', 'p1')).toBeNull()
    expect(events.at(-1)).toMatchObject({ payload: { paneId: 'p1', selection: null } })
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toBe('event: selection-cleared\ndata: 1\n\n')
    const count = events.length
    host.clearSelection('w1', 'p1')
    expect(events).toHaveLength(count)
  })

  it('copies text with its html first and the image only when there is no text', async () => {
    const { host, session, clipboard } = await opened()
    const base = { rect: RECT, frame: FRAME }
    const text = { kind: 'text', view: 'preview', range: { startLine: 1, endLine: 1 } }
    await postSelection(
      session,
      await selectionBody({ ...base, capture: text, text: 'hi', html: '<b>hi</b>' }, pngOf(4, 4)),
    )
    expect(await host.copySelection('w1', 'p1')).toBe('txt')
    expect(clipboard.at(-1)).toEqual({ text: 'hi', html: '<b>hi</b>' })
    await postSelection(session, await selectionBody({ ...base, capture: IMAGE }, pngOf(4, 4)))
    expect(await host.copySelection('w1', 'p1')).toBe('img')
    expect(Object.keys(clipboard.at(-1) ?? {})).toEqual(['png'])
    const pdf = { kind: 'pdf-region', page: 1, pageWidth: 600, pageHeight: 800, region: null }
    await postSelection(
      session,
      await selectionBody({ ...base, capture: pdf, text: 'abc' }, pngOf(9, 9)),
    )
    expect(await host.copySelection('w1', 'p1')).toBe('both')
    expect(Object.keys(clipboard.at(-1) ?? {}).sort()).toEqual(['png', 'text'])
  })

  it('copies cells as csv text and an html table', async () => {
    const { host, session, clipboard } = await opened()
    const cells = { kind: 'cells', sheet: 'S', range: 'A1:B2', rows: 2, columns: 2 }
    await postSelection(
      session,
      await selectionBody({
        rect: RECT,
        frame: FRAME,
        capture: cells,
        csv: 'a,"b <1>"\n"x ""y""",2',
      }),
    )
    expect(await host.copySelection('w1', 'p1')).toBe('cells')
    expect(clipboard.at(-1)).toEqual({
      text: 'a,"b <1>"\n"x ""y""",2',
      html: '<table><tbody><tr><td>a</td><td>b &lt;1&gt;</td></tr><tr><td>x &quot;y&quot;</td><td>2</td></tr></tbody></table>',
    })
  })

  it('answers the owner window only and says nothing to copy otherwise', async () => {
    const { host, session, clipboard, src, events } = await opened()
    expect(await host.copySelection('w1', 'p1')).toBeNull()
    await postSelection(
      session,
      await selectionBody({ capture: IMAGE, rect: RECT, frame: FRAME }, pngOf(4, 4)),
    )
    expect(await host.copySelection('w2', 'p1')).toBeNull()
    expect(await host.copySelection('w1', 'other')).toBeNull()
    expect(clipboard).toEqual([])
    expect(host.selectionForSend('w2', 'p1')).toBeNull()
    expect(host.selectionForSend('w1', 'p1')).toMatchObject({
      capture: { kind: 'image', file: FILE },
    })
    expect(host.copyForGuest({ getURL: () => src })).toBe(true)
    expect(host.copyForGuest({ getURL: () => 'https://example.com/' })).toBe(false)
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('copied'))
    expect(clipboard).toHaveLength(1)
    expect(events.at(-1)).toEqual({
      windowId: 'w1',
      type: 'copied',
      payload: { paneId: 'p1', label: expect.any(String) },
    })
  })

  it('takes a selection only within a moment of a trusted pointer or key input, without spending it', async () => {
    const harness = setup()
    const result = harness.host.open('w1', OPEN)
    if (!result.ok) throw new Error('not opened')
    const session = harness.sessions.get(SESSION)
    const guest = adoptGuest(harness.host, session, result.src)
    const body = await selectionBody({ capture: IMAGE, rect: RECT, frame: FRAME }, pngOf(4, 4))
    expect((await postSelection(session, body)).status).toBe(403)
    expect(harness.events).toEqual([])
    guest.emit('input-event', {}, { type: 'mouseDown' })
    expect((await postSelection(session, body)).status).toBe(204)
    expect((await postSelection(session, body)).status).toBe(204)
    harness.clock.now += GESTURE_WINDOW_MS + 1
    expect((await postSelection(session, body)).status).toBe(403)
    guest.emit('before-input-event', {}, { type: 'keyDown' })
    expect((await postSelection(session, body)).status).toBe(204)
    harness.clock.now += GESTURE_WINDOW_MS + 1
    guest.emit('input-event', {}, { type: 'mouseMove' })
    guest.emit('before-input-event', {}, { type: 'keyUp' })
    expect((await postSelection(session, body)).status).toBe(403)
  })

  it('numbers every accepted selection', async () => {
    const { session, events } = await opened()
    const body = await selectionBody({ capture: IMAGE, rect: RECT, frame: FRAME }, pngOf(4, 4))
    await postSelection(session, body)
    await postSelection(session, body)
    await postSelection(session, new Uint8Array([1]))
    await postSelection(session, body)
    const seqs = events.map((e) => (e.payload as { selection: { seq: number } }).selection.seq)
    expect(seqs).toEqual([1, 2, 3])
  })

  it('forgets the selection when the page reloads and when the file changes', async () => {
    const { host, session, events, guest, src, click } = await opened()
    const body = await selectionBody({ capture: IMAGE, rect: RECT, frame: FRAME }, pngOf(4, 4))
    await postSelection(session, body)
    expect(host.selectionForSend('w1', 'p1')).not.toBeNull()
    guest.emit('did-navigate', {}, src)
    expect(host.selectionForSend('w1', 'p1')).toBeNull()
    expect(events.at(-1)).toMatchObject({ payload: { paneId: 'p1', selection: null } })
    click()
    await postSelection(session, body)
    expect(host.selectionForSend('w1', 'p1')).not.toBeNull()
    await host.changed(viewerOwner('t1'))
    expect(host.selectionForSend('w1', 'p1')).toBeNull()
    expect(events.at(-1)).toMatchObject({ payload: { selection: null } })
    const count = events.length
    await host.changed(viewerOwner('t1'))
    expect(events).toHaveLength(count)
  })

  it('refuses a png whose header is wrong or whose pixels could be a bomb', async () => {
    const { session, events } = await opened()
    const send = async (png: Uint8Array): Promise<number> =>
      (
        await postSelection(
          session,
          await selectionBody({ capture: IMAGE, rect: RECT, frame: FRAME }, png),
        )
      ).status
    const notHeader = pngOf(5, 5)
    notHeader.set([0x49, 0x44, 0x41, 0x54], 12)
    expect(await send(notHeader)).toBe(400)
    expect(await send(pngOf(16_385, 10))).toBe(400)
    expect(await send(pngOf(10, 16_385))).toBe(400)
    expect(await send(pngOf(20_000, 20_000))).toBe(400)
    expect(await send(pngOf(12_000, 9_000))).toBe(400)
    expect(await send(pngOf(10_000, 9_999))).toBe(204)
    expect(events).toHaveLength(1)
  })

  it('stops reading a body that has no length and grows past the cap', async () => {
    const { session } = await opened()
    const chunk = new Uint8Array(10 * 1024 * 1024)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        sent += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    const res = await get(session, 'ostia-viewer://t1/~selection', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(413)
    expect(sent).toBeLessThan(80 * 1024 * 1024)
  })
})
