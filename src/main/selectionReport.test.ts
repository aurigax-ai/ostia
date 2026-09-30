import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SelectionCapture, SelectionSendRequest } from '../shared/selection'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, webContents: {} }))
vi.mock('./bus', () => ({ postBusMessage: vi.fn(() => 'msg-1') }))

const { postBusMessage } = await import('./bus')
const { writeSelectionReport } = await import('./selectionReport')
const { SELECTION_IMAGE_MAX } = await import('../shared/selection')
const { registerPane, removePane } = await import('./idRegistry')

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const AT = new Date('2026-09-29T10:00:00.000Z')

const textCapture: SelectionCapture = {
  kind: 'text',
  file: '/home/u/proj/src/app.ts',
  view: 'source',
  range: { startLine: 3, startColumn: 1, endLine: 4, endColumn: 9 },
  text: 'const a = 1\nconst b',
}

const imageCapture: SelectionCapture = {
  kind: 'image',
  file: '/home/u/shot.png',
  imageWidth: 640,
  imageHeight: 480,
  region: { x: 10, y: 20, width: 100, height: 50 },
}

function request(over: Partial<SelectionSendRequest> = {}): SelectionSendRequest {
  return {
    capture: textCapture,
    sourcePaneId: 'editor-1',
    targetPaneId: 'term-1',
    note: 'rename this',
    ...over,
  }
}

let prevTmp: string | undefined

beforeAll(() => {
  prevTmp = process.env.TMPDIR
  process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'pine-selection-test-'))
  registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'editor-1' })
  registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'term-1' })
})

afterAll(() => {
  process.env.TMPDIR = prevTmp
  removePane('editor-1')
  removePane('term-1')
})

afterEach(() => {
  vi.mocked(postBusMessage).mockClear()
})

describe('writeSelectionReport', () => {
  it('writes a private text report with the file, range, selection and note', () => {
    const res = writeSelectionReport(request(), 'w1', AT)
    if (!res.ok) throw new Error(res.error)
    expect(res.path).toMatch(/pine-reports-\d+\/selection-\d+\.md$/)
    expect(res.imagePath).toBeNull()
    const md = readFileSync(res.path, 'utf8')
    expect(md).toContain('- File: /home/u/proj/src/app.ts')
    expect(md).toContain('- Lines: 3:1-4:9')
    expect(md).toContain('```ts\nconst a = 1\nconst b\n```')
    expect(md).toContain('rename this')
    expect(md).toContain('- Captured: 2026-09-29T10:00:00.000Z')
    expect(statSync(res.path).mode & 0o777).toBe(0o600)
  })

  it('posts a selection bus message from the source pane to the target pane', () => {
    const res = writeSelectionReport(request(), 'w1', AT)
    if (!res.ok) throw new Error(res.error)
    const [from, to, text] = vi.mocked(postBusMessage).mock.calls[0]
    expect(from).not.toBe(to)
    expect(JSON.parse(text)).toEqual({
      kind: 'selection',
      report: res.path,
      file: '/home/u/proj/src/app.ts',
      image: null,
      note: 'rename this',
    })
  })

  it('saves the PNG next to the report and references it', () => {
    const res = writeSelectionReport(request({ capture: imageCapture, image: PNG }), 'w1', AT)
    if (!res.ok) throw new Error(res.error)
    expect(res.imagePath).toBe(res.path.replace(/\.md$/, '.png'))
    expect([...readFileSync(res.imagePath as string)]).toEqual([...PNG])
    expect(statSync(res.imagePath as string).mode & 0o777).toBe(0o600)
    const md = readFileSync(res.path, 'utf8')
    expect(md).toContain(`- Snapshot: ${res.imagePath}`)
    expect(md).toContain('- Region: x 10, y 20, 100 × 50 (image px, origin top-left)')
  })

  it('numbers reports so a second one never overwrites the first', () => {
    const a = writeSelectionReport(request({ capture: imageCapture, image: PNG }), 'w1', AT)
    const b = writeSelectionReport(request({ capture: imageCapture, image: PNG }), 'w1', AT)
    if (!a.ok || !b.ok) throw new Error('write failed')
    expect(a.path).not.toBe(b.path)
    expect(a.imagePath).not.toBe(b.imagePath)
    expect(existsSync(a.imagePath as string)).toBe(true)
  })

  it('refuses a sender window that does not own the source pane', () => {
    expect(writeSelectionReport(request(), 'w2', AT)).toEqual({ ok: false, error: 'not-found' })
  })

  it('refuses an unknown target pane', () => {
    expect(writeSelectionReport(request({ targetPaneId: 'ghost' }), 'w1', AT)).toEqual({
      ok: false,
      error: 'not-found',
    })
  })

  it('refuses an image capture without PNG bytes', () => {
    expect(writeSelectionReport(request({ capture: imageCapture }), 'w1', AT)).toEqual({
      ok: false,
      error: 'invalid',
    })
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0])
    expect(writeSelectionReport(request({ capture: imageCapture, image: jpeg }), 'w1', AT)).toEqual(
      { ok: false, error: 'invalid' },
    )
    expect(postBusMessage).not.toHaveBeenCalled()
  })

  it('refuses an image over the size cap', () => {
    const big = new Uint8Array(SELECTION_IMAGE_MAX + 1)
    big.set(PNG.subarray(0, 8))
    expect(writeSelectionReport(request({ capture: imageCapture, image: big }), 'w1', AT)).toEqual({
      ok: false,
      error: 'image-too-large',
    })
  })

  it('refuses a malformed capture', () => {
    const bad = { ...textCapture, file: 'relative/path.ts' } as SelectionCapture
    expect(writeSelectionReport(request({ capture: bad }), 'w1', AT)).toEqual({
      ok: false,
      error: 'invalid',
    })
  })
})
