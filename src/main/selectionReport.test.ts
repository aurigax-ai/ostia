import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FAKE } from '../../test/fixtures/secrets/samples'
import type { SelectionCapture, SelectionSendRequest } from '../shared/selection'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, webContents: {} }))
vi.mock('./bus', () => ({ postBusMessage: vi.fn(() => 'msg-1') }))

const { postBusMessage } = await import('./bus')
const { writeSelectionReport } = await import('./selectionReport')
const { createRedactor } = await import('./redaction')
const { testScan } = await import('../../test/redactionScan')
const { SELECTION_IMAGE_MAX } = await import('../shared/selection')
const { getByPaneId, registerPane, removePane } = await import('./idRegistry')

const sameWindow = (sender: string, _source: string, target: string): boolean =>
  getByPaneId(target)?.windowId === sender

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

describe('writeSelectionReport with secret redaction', () => {
  const secret = FAKE.githubClassic
  const leaking = (): SelectionSendRequest =>
    request({
      capture: { ...textCapture, text: `const token = '${secret}'` } as SelectionCapture,
      note: `rotate ${secret}`,
    })

  it('writes the report and the bus message with the secret redacted', async () => {
    const redactor = createRedactor(() => undefined, testScan)
    const res = await writeSelectionReport(leaking(), 'w1', sameWindow, AT, redactor.text)
    if (!res.ok) throw new Error(res.error)
    const md = readFileSync(res.path, 'utf8')
    expect(md).not.toContain(secret)
    expect(md).toContain("const token = '[redacted:github]'")
    expect(md).toContain('rotate [redacted:github]')
    expect(md).toContain('- File: /home/u/proj/src/app.ts')
    const [, , text] = vi.mocked(postBusMessage).mock.calls[0]
    expect(JSON.parse(text)).toMatchObject({ report: res.path, note: 'rotate [redacted:github]' })
  })

  it('writes the selection as it is while the setting is off', async () => {
    const redactor = createRedactor(() => ({ redaction: { enabled: false } }), testScan)
    const res = await writeSelectionReport(leaking(), 'w1', sameWindow, AT, redactor.text)
    if (!res.ok) throw new Error(res.error)
    expect(readFileSync(res.path, 'utf8')).toContain(`const token = '${secret}'`)
  })

  it('writes nothing when redaction fails', async () => {
    const res = await writeSelectionReport(leaking(), 'w1', sameWindow, AT, async () => {
      throw new Error('scan failed')
    })
    expect(res).toEqual({ ok: false, error: 'write-failed' })
    expect(postBusMessage).not.toHaveBeenCalled()
  })
})

describe('writeSelectionReport', () => {
  it('writes a private text report with the file, range, selection and note', async () => {
    const res = await writeSelectionReport(request(), 'w1', sameWindow, AT)
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

  it('posts a selection bus message from the source pane to the target pane', async () => {
    const res = await writeSelectionReport(request(), 'w1', sameWindow, AT)
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

  it('saves the PNG next to the report and references it', async () => {
    const res = await writeSelectionReport(
      request({ capture: imageCapture, image: PNG }),
      'w1',
      sameWindow,
      AT,
    )
    if (!res.ok) throw new Error(res.error)
    expect(res.imagePath).toBe(res.path.replace(/\.md$/, '.png'))
    expect([...readFileSync(res.imagePath as string)]).toEqual([...PNG])
    expect(statSync(res.imagePath as string).mode & 0o777).toBe(0o600)
    const md = readFileSync(res.path, 'utf8')
    expect(md).toContain(`- Snapshot: ${res.imagePath}`)
    expect(md).toContain('- Region: x 10, y 20, 100 × 50 (image px, origin top-left)')
  })

  it('numbers reports so a second one never overwrites the first', async () => {
    const a = await writeSelectionReport(
      request({ capture: imageCapture, image: PNG }),
      'w1',
      sameWindow,
      AT,
    )
    const b = await writeSelectionReport(
      request({ capture: imageCapture, image: PNG }),
      'w1',
      sameWindow,
      AT,
    )
    if (!a.ok || !b.ok) throw new Error('write failed')
    expect(a.path).not.toBe(b.path)
    expect(a.imagePath).not.toBe(b.imagePath)
    expect(existsSync(a.imagePath as string)).toBe(true)
  })

  it('refuses a target the sender cannot reach', async () => {
    const res = await writeSelectionReport(request(), 'w1', () => false, AT)

    expect(res).toEqual({ ok: false, error: 'not-found' })
    expect(postBusMessage).not.toHaveBeenCalled()
  })

  it('writes the report for a target in another window that the sender reaches', async () => {
    registerPane({ windowId: 'w9', workspaceId: 's9', paneId: 'agent-9' })
    const asked: string[][] = []
    const res = await writeSelectionReport(
      request({ targetPaneId: 'agent-9' }),
      'w1',
      (...args) => {
        asked.push(args)
        return true
      },
      AT,
    )
    removePane('agent-9')

    expect(res.ok).toBe(true)
    expect(asked).toEqual([['w1', 'editor-1', 'agent-9']])
  })

  it('refuses a sender window that does not own the source pane', async () => {
    expect(await writeSelectionReport(request(), 'w2', sameWindow, AT)).toEqual({
      ok: false,
      error: 'not-found',
    })
  })

  it('refuses an unknown target pane', async () => {
    expect(
      await writeSelectionReport(request({ targetPaneId: 'ghost' }), 'w1', sameWindow, AT),
    ).toEqual({
      ok: false,
      error: 'not-found',
    })
  })

  it('refuses an image capture without PNG bytes', async () => {
    expect(
      await writeSelectionReport(request({ capture: imageCapture }), 'w1', sameWindow, AT),
    ).toEqual({
      ok: false,
      error: 'invalid',
    })
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0])
    expect(
      await writeSelectionReport(
        request({ capture: imageCapture, image: jpeg }),
        'w1',
        sameWindow,
        AT,
      ),
    ).toEqual({ ok: false, error: 'invalid' })
    expect(postBusMessage).not.toHaveBeenCalled()
  })

  it('refuses an image over the size cap', async () => {
    const big = new Uint8Array(SELECTION_IMAGE_MAX + 1)
    big.set(PNG.subarray(0, 8))
    expect(
      await writeSelectionReport(
        request({ capture: imageCapture, image: big }),
        'w1',
        sameWindow,
        AT,
      ),
    ).toEqual({
      ok: false,
      error: 'image-too-large',
    })
  })

  it('refuses a malformed capture', async () => {
    const bad = { ...textCapture, file: 'relative/path.ts' } as SelectionCapture
    expect(await writeSelectionReport(request({ capture: bad }), 'w1', sameWindow, AT)).toEqual({
      ok: false,
      error: 'invalid',
    })
  })
})
