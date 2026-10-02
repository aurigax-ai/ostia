import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RawPick } from '../shared/pick'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, webContents: {} }))
vi.mock('./bus', () => ({ postBusMessage: vi.fn(() => 'msg-1') }))

const { postBusMessage } = await import('./bus')
const {
  PICK_WORLD_ID,
  cancelPick,
  clampPickTimeout,
  runPick,
  sanitizeTheme,
  writePickReport,
  DEFAULT_AGENT_PICK_TIMEOUT_MS,
  MAX_PICK_TIMEOUT_MS,
} = await import('./browsePick')
const { getByPaneId, registerPane, removePane } = await import('./idRegistry')

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
}

type Script = { code: string }

class FakeGuest extends EventEmitter {
  id = 42
  destroyed = false
  scripts: { world: number; code: string }[] = []
  pickResult: Promise<unknown> = Promise.resolve(raw)
  isDestroyed = (): boolean => this.destroyed
  getZoomFactor = (): number => 1
  capturePage = vi.fn(async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('png') }))
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
    errorBuffers: new Map([[42, [{ level: 'error', text: 'boom', ts: 1 }]]]),
    broadcast: vi.fn(),
  }
}

const opts = { timeoutMs: 5000, byAgent: false }
let prevTmp: string | undefined

beforeAll(() => {
  prevTmp = process.env.TMPDIR
  process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'pine-pick-test-'))
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
    expect(guest.scripts[0].code).toContain('window.__pinePick')
    expect(guest.scripts[0].code).not.toMatch(/PINE_TOKEN|ipcRenderer/)
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
    expect(shot).toMatch(/pine-reports-\d+\/pick-.*\.png$/)
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
    expect(guest.scripts.at(-1)?.code).toContain('window.__pinePick.cancel()')
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
    const res = writePickReport(
      { captureId: id, sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: 'misaligned' },
      'w1',
      sameWindow,
    )
    if (!res.ok) throw new Error(res.error)
    expect(res.path).toMatch(/pine-reports-\d+\/capture-\d+(-[a-z0-9-]+)?\.md$/)
    const md = readFileSync(res.path, 'utf8')
    expect(md).toContain('`#save`')
    expect(md).toContain('misaligned')
    expect(statSync(res.path).mode & 0o777).toBe(0o600)
    const [from, to, text] = vi.mocked(postBusMessage).mock.calls[0]
    expect(from).not.toBe(to)
    expect(JSON.parse(text)).toMatchObject({ kind: 'capture', report: res.path })
    expect(res.imagePath).toMatch(/pine-reports-\d+\/pick-.*\.png$/)
    expect(md).toContain(`![Captured element](${res.imagePath})`)
  })

  it('numbers reports so a second one never overwrites the first', async () => {
    const id = await captureId()
    const req = { captureId: id, sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: '' }
    const a = writePickReport(req, 'w1', sameWindow)
    const b = writePickReport(req, 'w1', sameWindow)
    if (!a.ok || !b.ok) throw new Error('write failed')
    expect(a.path).not.toBe(b.path)
  })

  it('refuses a sender window that does not own the browser pane', async () => {
    const id = await captureId()
    expect(
      writePickReport(
        { captureId: id, sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: '' },
        'w2',
        sameWindow,
      ),
    ).toEqual({ ok: false, error: 'not-found' })
  })

  it('refuses a capture id it never issued or one issued for another pane', async () => {
    expect(
      writePickReport(
        { captureId: 'pick-nope', sourcePaneId: 'browser-1', targetPaneId: 'term-1', note: '' },
        'w1',
        sameWindow,
      ),
    ).toEqual({ ok: false, error: 'capture-expired' })
    const id = await captureId()
    expect(
      writePickReport(
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

    const refused = writePickReport(req, 'w1', sameWindow)
    const asked: string[][] = []
    const sent = writePickReport(req, 'w1', (...args) => {
      asked.push(args)
      return true
    })
    removePane('agent-9')

    expect(refused).toEqual({ ok: false, error: 'not-found' })
    expect(sent.ok).toBe(true)
    expect(asked).toEqual([['w1', 'browser-1', 'agent-9']])
  })
})

describe('sanitizeTheme', () => {
  it('accepts plain color values', () => {
    expect(sanitizeTheme({ accent: '#00d8ff', surface: 'rgb(49, 53, 55)', fg: '#e3edf5' })).toEqual(
      { accent: '#00d8ff', surface: 'rgb(49, 53, 55)', fg: '#e3edf5' },
    )
  })

  it('rejects values that could break out of the style declaration', () => {
    expect(
      sanitizeTheme({ accent: 'red; background: url(x)', surface: '#000', fg: '#fff' }),
    ).toBeUndefined()
    expect(sanitizeTheme('nope')).toBeUndefined()
  })
})

describe('clampPickTimeout', () => {
  it('defaults and clamps', () => {
    expect(clampPickTimeout(undefined)).toBe(DEFAULT_AGENT_PICK_TIMEOUT_MS)
    expect(clampPickTimeout(1)).toBe(1000)
    expect(clampPickTimeout(10 ** 9)).toBe(MAX_PICK_TIMEOUT_MS)
  })
})
