import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: {},
  clipboard: { write: vi.fn(async () => undefined) },
  ClipboardItem: class {
    constructor(readonly items: Record<string, Blob>) {}
  },
}))
vi.mock('./browse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./browse')>()),
  ownedGuest: vi.fn(),
}))
vi.mock('../agents/bus', () => ({ postBusMessage: vi.fn(() => 'msg-1') }))

const { clipboard, ipcMain } = await import('electron')
const { ownedGuest } = await import('./browse')
const { postBusMessage } = await import('../agents/bus')
const { captureRegion, copyRegionImage, registerRegionIpc, writeRegionReport } = await import(
  './browseRegion'
)
const { getByPaneId, registerPane, removePane } = await import('../control/idRegistry')

const { PICK_NOTE_MAX } = await import('../../shared/pick')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

const sameWindow = (sender: string, _source: string, target: string): boolean =>
  getByPaneId(target)?.windowId === sender

function fakeGuest(over: { zoom?: number; empty?: boolean; png?: Buffer } = {}) {
  return {
    getURL: () => 'http://localhost:5173/cart',
    getTitle: () => 'Cart',
    getZoomFactor: () => over.zoom ?? 1,
    capturePage: vi.fn(async (rect: { width: number; height: number }) => ({
      isEmpty: () => over.empty ?? false,
      toPNG: () => over.png ?? PNG,
      getSize: () => ({ width: rect.width, height: rect.height }),
    })),
  }
}

const asGuest = (g: ReturnType<typeof fakeGuest>): Electron.WebContents =>
  g as unknown as Electron.WebContents

const request = {
  rect: { x: 10, y: 20, width: 120, height: 80 },
  view: { width: 800, height: 600 },
}

let prevTmp: string | undefined

beforeAll(() => {
  prevTmp = process.env.TMPDIR
  process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'ostia-region-test-'))
  registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'browser-1' })
  registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'term-1' })
})

afterAll(() => {
  process.env.TMPDIR = prevTmp
  removePane('browser-1')
  removePane('term-1')
})

afterEach(() => {
  vi.clearAllMocks()
})

async function captured(guest = fakeGuest()): Promise<string> {
  const outcome = await captureRegion(asGuest(guest), 1, 'browser-1', request)
  if (!outcome.ok) throw new Error(outcome.error)
  return outcome.capture.id
}

describe('captureRegion', () => {
  it('captures exactly the dragged rectangle, scaled by the window zoom', async () => {
    const guest = fakeGuest({ zoom: 2 })
    const outcome = await captureRegion(asGuest(guest), 1.5, 'browser-1', request)
    expect(guest.capturePage).toHaveBeenCalledWith({ x: 15, y: 30, width: 180, height: 120 })
    if (!outcome.ok) throw new Error(outcome.error)
    expect(outcome.capture).toMatchObject({
      url: 'http://localhost:5173/cart',
      title: 'Cart',
      rect: { x: 7.5, y: 15, width: 90, height: 60 },
      imageWidth: 180,
      imageHeight: 120,
    })
  })

  it('refuses a rectangle outside the pane or with bad numbers without capturing', async () => {
    const guest = fakeGuest()
    const outside = { ...request, rect: { x: 700, y: 0, width: 200, height: 50 } }
    const nan = { ...request, rect: { ...request.rect, x: Number.NaN } }
    expect(await captureRegion(asGuest(guest), 1, 'browser-1', outside)).toEqual({
      ok: false,
      error: 'invalid',
    })
    expect(await captureRegion(asGuest(guest), 1, 'browser-1', nan)).toEqual({
      ok: false,
      error: 'invalid',
    })
    expect(await captureRegion(asGuest(guest), 1, 'browser-1', 'x')).toEqual({
      ok: false,
      error: 'invalid',
    })
    expect(guest.capturePage).not.toHaveBeenCalled()
  })

  it('refuses an empty capture and one past the image size cap', async () => {
    expect(
      await captureRegion(asGuest(fakeGuest({ empty: true })), 1, 'browser-1', request),
    ).toEqual({ ok: false, error: 'empty' })
    const huge = Buffer.alloc(25 * 1024 * 1024 + 1)
    expect(await captureRegion(asGuest(fakeGuest({ png: huge })), 1, 'browser-1', request)).toEqual(
      { ok: false, error: 'image-too-large' },
    )
  })
})

describe('writeRegionReport', () => {
  it('writes the report and the bus message through the redactor', async () => {
    const id = await captured()
    const res = await writeRegionReport(
      { captureId: id, sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: 'key SECRET here' },
      'w1',
      sameWindow,
      async (text) => text.replaceAll('SECRET', '[redacted:test]'),
    )
    if (!res.ok) throw new Error(res.error)
    const md = readFileSync(res.path, 'utf8')
    expect(md).toContain('key [redacted:test] here')
    expect(md).not.toContain('SECRET')
    const [, , text] = vi.mocked(postBusMessage).mock.calls.at(-1) ?? []
    expect(JSON.parse(text as string).note).toBe('key [redacted:test] here')
  })

  it('writes the PNG and the report side by side, private, and posts a bus message', async () => {
    const id = await captured()
    const res = await writeRegionReport(
      { captureId: id, sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: 'overlap' },
      'w1',
      sameWindow,
    )
    if (!res.ok) throw new Error(res.error)
    expect(basename(res.path)).toMatch(/^capture-\d+-localhost-5173-cart\.md$/)
    expect(res.imagePath).toBe(res.path.replace(/\.md$/, '.png'))
    expect(readFileSync(res.imagePath as string)).toEqual(PNG)
    const md = readFileSync(res.path, 'utf8')
    expect(md).toContain('overlap')
    expect(md).toContain(`![Captured region](${res.imagePath})`)
    expect(statSync(res.path).mode & 0o777).toBe(0o600)
    expect(statSync(res.imagePath as string).mode & 0o777).toBe(0o600)
    const [, , text] = vi.mocked(postBusMessage).mock.calls[0]
    expect(JSON.parse(text)).toMatchObject({
      kind: 'capture',
      report: res.path,
      image: res.imagePath,
    })
  })

  it('numbers after pick reports so names never collide', async () => {
    const id = await captured()
    const req = { captureId: id, sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: '' }
    const a = await writeRegionReport(req, 'w1', sameWindow)
    const b = await writeRegionReport(req, 'w1', sameWindow)
    if (!a.ok || !b.ok) throw new Error('write failed')
    expect(a.path).not.toBe(b.path)
    expect(a.imagePath).not.toBe(b.imagePath)
  })

  it('refuses a sender that does not own the browser pane, or an unknown capture', async () => {
    const id = await captured()
    expect(
      await writeRegionReport(
        { captureId: id, sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: '' },
        'w2',
        sameWindow,
      ),
    ).toEqual({ ok: false, error: 'not-found' })
    expect(
      await writeRegionReport(
        { captureId: 'region-nope', sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: '' },
        'w1',
        sameWindow,
      ),
    ).toEqual({ ok: false, error: 'capture-expired' })
    expect(
      await writeRegionReport(
        { captureId: id, sourcePaneId: 'term-1', targetPaneId: 'browser-1', note: '' },
        'w1',
        sameWindow,
      ),
    ).toEqual({ ok: false, error: 'capture-expired' })
  })

  it('clips an oversized note and treats a non-string note as empty', async () => {
    const id = await captured()
    const send = (note: unknown) =>
      writeRegionReport(
        {
          captureId: id,
          sourcePaneId: 'browser-1',
          targetPaneId: 'term-1',
          note,
        } as unknown as Parameters<typeof writeRegionReport>[0],
        'w1',
        sameWindow,
      )
    const long = await send('x'.repeat(PICK_NOTE_MAX + 500))
    const numeric = await send(12345)
    if (!long.ok || !numeric.ok) throw new Error('write failed')
    const longNote = readFileSync(long.path, 'utf8').split('## Note\n\n')[1].split('\n')[0]
    expect(longNote).toBe(`${'x'.repeat(PICK_NOTE_MAX - 1)}…`)
    expect(readFileSync(numeric.path, 'utf8')).toContain('## Note\n\n(no note)\n')
    const sent = vi.mocked(postBusMessage).mock.calls.map(([, , text]) => JSON.parse(text).note)
    expect(sent).toEqual([`${'x'.repeat(PICK_NOTE_MAX - 1)}…`, ''])
  })

  it('refuses a target the sender cannot reach', async () => {
    registerPane({ windowId: 'w9', workspaceId: 's9', paneId: 'agent-9' })
    const id = await captured()
    const res = await writeRegionReport(
      { captureId: id, sourcePaneId: 'browser-1', targetPaneId: 'agent-9', note: '' },
      'w1',
      sameWindow,
    )
    removePane('agent-9')
    expect(res).toEqual({ ok: false, error: 'not-found' })
  })
})

describe('copyRegionImage', () => {
  it('writes the captured PNG to the clipboard for the owning window only', async () => {
    const id = await captured()
    expect(await copyRegionImage('browser-1', id, 'w2')).toEqual({ ok: false, error: 'not-found' })
    expect(await copyRegionImage('term-1', id, 'w1')).toEqual({
      ok: false,
      error: 'capture-expired',
    })
    expect(clipboard.write).not.toHaveBeenCalled()
    expect(await copyRegionImage('browser-1', id, 'w1')).toEqual({ ok: true })
    const [[items]] = vi.mocked(clipboard.write).mock.calls
    expect(items).toHaveLength(1)
    const png = (items[0] as unknown as { items: Record<string, Blob> }).items['image/png']
    expect(Buffer.from(await png.arrayBuffer())).toEqual(PNG)
  })
})

describe('registerRegionIpc', () => {
  const handler = (channel: string) => {
    const call = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)
    if (!call) throw new Error(`no handler ${channel}`)
    return call[1] as (e: unknown, ...args: unknown[]) => Promise<unknown>
  }
  const sender = (id: number) => ({ sender: { id, getZoomFactor: () => 1 } })

  it('captures only through a guest the sending window owns', async () => {
    registerRegionIpc(new Map([['browser-1', 7]]), sameWindow, async (text) => text)
    const guest = fakeGuest()
    vi.mocked(ownedGuest).mockReturnValueOnce(null)
    expect(await handler('browser:region-capture')(sender(2), 'browser-1', request)).toEqual({
      ok: false,
      error: 'browser-not-ready',
    })
    expect(guest.capturePage).not.toHaveBeenCalled()
    vi.mocked(ownedGuest).mockReturnValueOnce(asGuest(guest))
    const outcome = (await handler('browser:region-capture')(sender(1), 'browser-1', request)) as {
      ok: boolean
    }
    expect(outcome.ok).toBe(true)
    expect(guest.capturePage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ownedGuest).mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['browser-1', '2'],
      ['browser-1', '1'],
    ])
  })
})

describe('stored regions', () => {
  it('keeps only the five newest captures and evicts the oldest', async () => {
    const ids: string[] = []
    for (let i = 0; i < 6; i++) ids.push(await captured())
    expect(await copyRegionImage('browser-1', ids[0], 'w1')).toEqual({
      ok: false,
      error: 'capture-expired',
    })
    expect(await copyRegionImage('browser-1', ids[1], 'w1')).toEqual({ ok: true })
    expect(await copyRegionImage('browser-1', ids[5], 'w1')).toEqual({ ok: true })
    const stale = await writeRegionReport(
      { captureId: ids[0], sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: '' },
      'w1',
      sameWindow,
    )
    expect(stale).toEqual({ ok: false, error: 'capture-expired' })
  })
})
