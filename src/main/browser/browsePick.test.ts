import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RawPick } from '../../shared/browser/pick'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, webContents: {} }))
vi.mock('../agents/busStore', () => ({ postBusMessage: vi.fn(() => 'msg-1') }))

const { postBusMessage } = await import('../agents/busStore')
const {
  PICK_WORLD_ID,
  cancelPick,
  clampPickTimeout,
  copyPick,
  readPageSelection,
  runPick,
  sanitizeTheme,
  writePickReport,
  DEFAULT_AGENT_PICK_TIMEOUT_MS,
  MAX_PICK_TIMEOUT_MS,
} = await import('./browsePick')
const { getByPaneId, registerPane, removePane } = await import('../control/idRegistry')
const { ownWorkspaceReach } = await import('../../../test/reach')

const sameWindow = (sender: string, _source: string, target: string): boolean =>
  getByPaneId(target)?.windowId === sender

const raw: RawPick = {
  url: 'http://localhost/page',
  title: 'Page',
  selector: '#save',
  label: 'button#save  80×24',
  html: '<button id="save">Save</button>',
  box: { x: 10, y: 10, width: 80, height: 24 },
  viewport: { width: 800, height: 600 },
  styles: { display: 'inline-block' },
  role: 'button',
  name: 'Save',
  hasText: true,
  table: null,
}

type Script = { code: string }

class FakeGuest extends EventEmitter {
  id = 42
  destroyed = false
  scripts: { world: number; code: string }[] = []
  pickResult: Promise<unknown> = Promise.resolve(raw)
  isDestroyed = (): boolean => this.destroyed
  getZoomFactor = (): number => 1
  capturePage = vi.fn(
    async (): Promise<{ isEmpty: () => boolean; toPNG: () => Buffer }> => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from('png'),
    }),
  )
  executeJavaScriptInIsolatedWorld = vi.fn(async (world: number, scripts: Script[]) => {
    const code = scripts[0].code
    this.scripts.push({ world, code })
    return code.includes('.start(') ? this.pickResult : undefined
  })
}

const asGuest = (g: FakeGuest): Electron.WebContents => g as unknown as Electron.WebContents

function deps() {
  return {
    browserPanes: new Map<string, number>(),
    isSharedPane: () => false,
    reach: ownWorkspaceReach(),
    errorBuffers: new Map([[42, [{ level: 'error', text: 'boom', ts: 1 }]]]),
    broadcast: vi.fn(),
  }
}

const opts = { timeoutMs: 5000, byAgent: false }
let prevTmp: string | undefined

beforeAll(() => {
  prevTmp = process.env.TMPDIR
  process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'ostia-pick-test-'))
  registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'browser-1' })
  registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'term-1' })
})

afterAll(() => {
  process.env.TMPDIR = prevTmp
  removePane('browser-1')
  removePane('term-1')
})

afterEach(() => {
  cancelPick('browser-1')
  vi.clearAllMocks()
})

describe('runPick', () => {
  it('runs the inspector in an isolated world, never the page main world', async () => {
    const guest = new FakeGuest()
    await runPick(deps(), asGuest(guest), 'browser-1', opts)
    expect(guest.scripts.length).toBeGreaterThan(0)
    for (const s of guest.scripts) expect(s.world).toBe(PICK_WORLD_ID)
    expect(PICK_WORLD_ID).not.toBe(0)
    expect(guest.scripts[0].code).toContain('window.__ostiaPick')
    expect(guest.scripts[0].code).not.toMatch(/OSTIA_TOKEN|ipcRenderer/)
  })

  it('returns a capture with console errors and an element screenshot', async () => {
    const guest = new FakeGuest()
    const d = deps()
    const outcome = await runPick(d, asGuest(guest), 'browser-1', opts)
    if (!outcome.ok) throw new Error(outcome.error)
    expect(outcome.capture.selector).toBe('#save')
    expect(outcome.capture.consoleErrors).toEqual([{ level: 'error', text: 'boom', ts: 1 }])
    expect(guest.capturePage).toHaveBeenCalledWith({ x: 0, y: 0, width: 106, height: 50 })
    const shot = outcome.capture.screenshotPath
    expect(shot).toMatch(/ostia-reports-\d+\/pick-.*\.png$/)
    expect(readFileSync(shot as string, 'utf8')).toBe('png')
    expect(d.broadcast.mock.calls.map((c) => c[1].active)).toEqual([true, false])
  })

  it('refuses a second pick on the same pane while one is active', async () => {
    const guest = new FakeGuest()
    guest.pickResult = new Promise(() => {})
    const first = runPick(deps(), asGuest(guest), 'browser-1', opts)
    await expect(runPick(deps(), asGuest(guest), 'browser-1', opts)).resolves.toEqual({
      ok: false,
      error: 'busy',
    })
    cancelPick('browser-1')
    await expect(first).resolves.toEqual({ ok: false, error: 'cancelled' })
  })

  it('tears the overlay down in the page when cancelled from outside', async () => {
    const guest = new FakeGuest()
    guest.pickResult = new Promise(() => {})
    const pick = runPick(deps(), asGuest(guest), 'browser-1', opts)
    expect(cancelPick('browser-1')).toBe(true)
    await pick
    expect(guest.scripts.at(-1)?.code).toContain('window.__ostiaPick.cancel()')
  })

  it('reports cancelled when the user presses Escape in the page', async () => {
    const guest = new FakeGuest()
    guest.pickResult = Promise.resolve(null)
    await expect(runPick(deps(), asGuest(guest), 'browser-1', opts)).resolves.toEqual({
      ok: false,
      error: 'cancelled',
    })
  })

  it('times out', async () => {
    const guest = new FakeGuest()
    guest.pickResult = new Promise(() => {})
    const outcome = await runPick(deps(), asGuest(guest), 'browser-1', { ...opts, timeoutMs: 5 })
    expect(outcome).toEqual({ ok: false, error: 'timeout' })
  })

  it('ends the pick when the main frame navigates away', async () => {
    const guest = new FakeGuest()
    guest.pickResult = new Promise(() => {})
    const pick = runPick(deps(), asGuest(guest), 'browser-1', opts)
    guest.emit('did-start-navigation', {}, 'http://elsewhere', true, true)
    guest.emit('did-start-navigation', {}, 'http://elsewhere', false, false)
    guest.emit('did-start-navigation', {}, 'http://elsewhere', false, true)
    await expect(pick).resolves.toEqual({ ok: false, error: 'navigated' })
  })
})

describe('writePickReport', () => {
  async function captureId(): Promise<string> {
    const outcome = await runPick(deps(), asGuest(new FakeGuest()), 'browser-1', opts)
    if (!outcome.ok) throw new Error(outcome.error)
    return outcome.capture.id
  }

  it('writes a private markdown report and posts a bus message to the target', async () => {
    const id = await captureId()
    const res = await writePickReport(
      { captureId: id, sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: 'misaligned' },
      'w1',
      sameWindow,
    )
    if (!res.ok) throw new Error(res.error)
    expect(res.path).toMatch(/ostia-reports-\d+\/capture-\d+(-[a-z0-9-]+)?\.md$/)
    const md = readFileSync(res.path, 'utf8')
    expect(md).toContain('`#save`')
    expect(md).toContain('misaligned')
    expect(statSync(res.path).mode & 0o777).toBe(0o600)
    const [from, to, text] = vi.mocked(postBusMessage).mock.calls[0]
    expect(from).not.toBe(to)
    expect(JSON.parse(text)).toMatchObject({ kind: 'capture', report: res.path })
    expect(res.imagePath).toMatch(/ostia-reports-\d+\/pick-.*\.png$/)
    expect(md).toContain(`![Captured element](${res.imagePath})`)
  })

  it('writes the report and the bus message through the redactor', async () => {
    const id = await captureId()
    const res = await writePickReport(
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

  it('numbers reports so a second one never overwrites the first', async () => {
    const id = await captureId()
    const req = { captureId: id, sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: '' }
    const a = await writePickReport(req, 'w1', sameWindow)
    const b = await writePickReport(req, 'w1', sameWindow)
    if (!a.ok || !b.ok) throw new Error('write failed')
    expect(a.path).not.toBe(b.path)
  })

  it('refuses a sender window that does not own the browser pane', async () => {
    const id = await captureId()
    expect(
      await writePickReport(
        { captureId: id, sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: '' },
        'w2',
        sameWindow,
      ),
    ).toEqual({ ok: false, error: 'not-found' })
  })

  it('refuses a capture id it never issued or one issued for another pane', async () => {
    expect(
      await writePickReport(
        { captureId: 'pick-nope', sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: '' },
        'w1',
        sameWindow,
      ),
    ).toEqual({ ok: false, error: 'capture-expired' })
    const id = await captureId()
    expect(
      await writePickReport(
        { captureId: id, sourcePaneId: 'term-1', targetPaneId: 'browser-1', note: '' },
        'w1',
        sameWindow,
      ),
    ).toEqual({ ok: false, error: 'capture-expired' })
  })

  it('refuses a target the sender cannot reach and allows one it reaches in another window', async () => {
    registerPane({ windowId: 'w9', workspaceId: 's9', paneId: 'agent-9' })
    const id = await captureId()
    const req = { captureId: id, sourcePaneId: 'browser-1', targetPaneId: 'agent-9', note: '' }

    const refused = await writePickReport(req, 'w1', sameWindow)
    const asked: string[][] = []
    const sent = await writePickReport(req, 'w1', (...args) => {
      asked.push(args)
      return true
    })
    removePane('agent-9')

    expect(refused).toEqual({ ok: false, error: 'not-found' })
    expect(sent.ok).toBe(true)
    expect(asked).toEqual([['w1', 'browser-1', 'agent-9']])
  })
})

describe('copyPick', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

  async function pickOf(over: Partial<RawPick>, png: Buffer = PNG) {
    const guest = new FakeGuest()
    guest.pickResult = Promise.resolve({ ...raw, ...over })
    guest.capturePage = vi.fn(async () => ({ isEmpty: () => false, toPNG: () => png }))
    const outcome = await runPick(deps(), asGuest(guest), 'browser-1', opts)
    if (!outcome.ok) throw new Error(outcome.error)
    return outcome.capture
  }

  it('copies the report as text when the element has text, without the note or the image', async () => {
    const capture = await pickOf({})
    const write = vi.fn(async () => undefined)
    expect(await copyPick('browser-1', capture.id, 'w1', write)).toEqual({
      ok: true,
      kind: 'report',
    })
    const written = write.mock.calls[0] as unknown as [{ text?: string; png?: Uint8Array }]
    expect(written[0].png).toBeUndefined()
    expect(written[0].text).toContain('`#save`')
    expect(written[0].text).not.toContain('## Note')
  })

  it('copies the element screenshot when the element has no text', async () => {
    const capture = await pickOf({ hasText: false })
    const write = vi.fn(async () => undefined)
    expect(await copyPick('browser-1', capture.id, 'w1', write)).toEqual({
      ok: true,
      kind: 'image',
    })
    const written = write.mock.calls[0] as unknown as [{ text?: string; png?: Uint8Array }]
    expect(Buffer.from(written[0].png ?? []).equals(PNG)).toBe(true)
    expect(written[0].text).toBeUndefined()
  })

  it('falls back to the report when the screenshot is not a png', async () => {
    const capture = await pickOf({ hasText: false }, Buffer.from('not a png'))
    const write = vi.fn(async () => undefined)
    expect(await copyPick('browser-1', capture.id, 'w1', write)).toEqual({
      ok: true,
      kind: 'report',
    })
  })

  it('copies a table as csv text and says its shape', async () => {
    const capture = await pickOf({
      table: [
        ['Order', 'Total'],
        ['#1', '1,232.00'],
      ],
    })
    const write = vi.fn(async () => undefined)
    expect(await copyPick('browser-1', capture.id, 'w1', write)).toEqual({
      ok: true,
      kind: 'table',
      rows: 2,
      columns: 2,
    })
    expect(write).toHaveBeenCalledWith({ text: 'Order,Total\n#1,"1,232.00"' })
  })

  it('refuses another window, a stranger pane and an unknown capture', async () => {
    const capture = await pickOf({})
    const write = vi.fn(async () => undefined)
    expect(await copyPick('browser-1', capture.id, 'w2', write)).toEqual({
      ok: false,
      error: 'not-found',
    })
    expect(await copyPick('term-1', capture.id, 'w1', write)).toEqual({
      ok: false,
      error: 'capture-expired',
    })
    expect(await copyPick('browser-1', 'pick-none', 'w1', write)).toEqual({
      ok: false,
      error: 'capture-expired',
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('reports a clipboard that refused the write', async () => {
    const capture = await pickOf({})
    expect(
      await copyPick('browser-1', capture.id, 'w1', async () => {
        throw new Error('denied')
      }),
    ).toEqual({ ok: false, error: 'write-failed' })
  })
})

describe('readPageSelection', () => {
  it('reads the selection in the isolated world and validates what comes back', async () => {
    const guest = new FakeGuest()
    guest.executeJavaScriptInIsolatedWorld = vi.fn(async () => ({
      url: 'https://example.com/a',
      title: 'A',
      text: 'Refund pending',
      box: { x: 4, y: 8, width: 100, height: 20 },
      viewport: { width: 800, height: 600 },
    }))
    expect(await readPageSelection(asGuest(guest))).toEqual({
      capture: {
        kind: 'page-text',
        url: 'https://example.com/a',
        title: 'A',
        text: 'Refund pending',
      },
      box: { x: 4, y: 8, width: 100, height: 20 },
      viewport: { width: 800, height: 600 },
    })
    expect(guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(PICK_WORLD_ID, [
      expect.objectContaining({ code: expect.stringContaining('.selection()') }),
    ])
  })

  it('answers null for no selection, a hostile page or a failed script', async () => {
    const guest = new FakeGuest()
    guest.executeJavaScriptInIsolatedWorld = vi.fn(async () => null)
    expect(await readPageSelection(asGuest(guest))).toBeNull()
    guest.executeJavaScriptInIsolatedWorld = vi.fn(async () => ({
      url: 'javascript:alert(1)',
      text: 'x',
    }))
    expect(await readPageSelection(asGuest(guest))).toBeNull()
    guest.executeJavaScriptInIsolatedWorld = vi.fn(async () => {
      throw new Error('gone')
    })
    expect(await readPageSelection(asGuest(guest))).toBeNull()
  })
})

describe('sanitizeTheme', () => {
  it('accepts plain color values', async () => {
    expect(sanitizeTheme({ accent: '#00d8ff', surface: 'rgb(49, 53, 55)', fg: '#e3edf5' })).toEqual(
      { accent: '#00d8ff', surface: 'rgb(49, 53, 55)', fg: '#e3edf5' },
    )
  })

  it('rejects values that could break out of the style declaration', async () => {
    expect(
      sanitizeTheme({ accent: 'red; background: url(x)', surface: '#000', fg: '#fff' }),
    ).toBeUndefined()
    expect(sanitizeTheme('nope')).toBeUndefined()
  })
})

describe('clampPickTimeout', () => {
  it('defaults and clamps', async () => {
    expect(clampPickTimeout(undefined)).toBe(DEFAULT_AGENT_PICK_TIMEOUT_MS)
    expect(clampPickTimeout(1)).toBe(1000)
    expect(clampPickTimeout(10 ** 9)).toBe(MAX_PICK_TIMEOUT_MS)
  })
})
