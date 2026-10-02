import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: {},
  clipboard: { writeImage: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn((buf: Buffer) => ({ fromBuffer: buf })) },
}))
vi.mock('./bus', () => ({ postBusMessage: vi.fn(() => 'msg-1') }))

const { clipboard } = await import('electron')
const { postBusMessage } = await import('./bus')
const { captureRegion, copyRegionImage, writeRegionReport } = await import('./browseRegion')
const { getByPaneId, registerPane, removePane } = await import('./idRegistry')

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
  process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'pine-region-test-'))
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
  it('writes the PNG and the report side by side, private, and posts a bus message', async () => {
    const id = await captured()
    const res = writeRegionReport(
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
    const a = writeRegionReport(req, 'w1', sameWindow)
    const b = writeRegionReport(req, 'w1', sameWindow)
    if (!a.ok || !b.ok) throw new Error('write failed')
    expect(a.path).not.toBe(b.path)
    expect(a.imagePath).not.toBe(b.imagePath)
  })

  it('refuses a sender that does not own the browser pane, or an unknown capture', async () => {
    const id = await captured()
    expect(
      writeRegionReport(
        { captureId: id, sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: '' },
        'w2',
        sameWindow,
      ),
    ).toEqual({ ok: false, error: 'not-found' })
    expect(
      writeRegionReport(
        { captureId: 'region-nope', sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: '' },
        'w1',
        sameWindow,
      ),
    ).toEqual({ ok: false, error: 'capture-expired' })
    expect(
      writeRegionReport(
        { captureId: id, sourcePaneId: 'term-1', targetPaneId: 'browser-1', note: '' },
        'w1',
        sameWindow,
      ),
    ).toEqual({ ok: false, error: 'capture-expired' })
  })

  it('refuses a target the sender cannot reach', async () => {
    registerPane({ windowId: 'w9', workspaceId: 's9', paneId: 'agent-9' })
    const id = await captured()
    const res = writeRegionReport(
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
    expect(copyRegionImage('browser-1', id, 'w2')).toEqual({ ok: false, error: 'not-found' })
    expect(copyRegionImage('term-1', id, 'w1')).toEqual({ ok: false, error: 'capture-expired' })
    expect(clipboard.writeImage).not.toHaveBeenCalled()
    expect(copyRegionImage('browser-1', id, 'w1')).toEqual({ ok: true })
    expect(clipboard.writeImage).toHaveBeenCalledWith({ fromBuffer: PNG })
  })
})
