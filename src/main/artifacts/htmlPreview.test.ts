import {
  type FSWatcher,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, watch: vi.fn(fs.watch) }
})

import {
  PREVIEW_LIMITS,
  type PreviewEvent,
  type PreviewOpened,
} from '../../shared/artifacts/htmlPreview'
import { PORTABLE_CSP } from '../../shared/artifacts/portable'
import { PreviewHost } from './htmlPreview'
import { hardenPreviewAttach, previewHeaders } from './previewAttach'
import type { PreviewSource } from './previewFiles'
import type { PreviewGuest, PreviewSession, ProcessUse } from './previewHostTypes'

const MIB = 1024 * 1024

let base: string
let folder: string
let page: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-preview-test-')))
  folder = join(base, 'site')
  mkdirSync(join(folder, 'assets'), { recursive: true })
  page = join(folder, 'page.html')
  writeFileSync(page, '<!doctype html><title>t</title>')
  writeFileSync(join(folder, 'data.json'), '{"a":1}')
  writeFileSync(join(folder, 'assets', 'app.js'), 'export const a = 1')
  writeFileSync(join(base, 'outside.txt'), 'outside')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('previewHeaders', () => {
  it('PRT-C21 sends the portable policy with the frame’s sandbox as headers', () => {
    const headers = previewHeaders('/a/App.tsx')
    expect(headers['content-security-policy'].split(', ')[0]).toBe(PORTABLE_CSP)
    expect(headers['content-security-policy']).toContain('sandbox allow-scripts')
    expect(headers['content-security-policy']).not.toMatch(/unsafe-eval|allow-same-origin/)
    expect(headers).toMatchObject({
      'x-dns-prefetch-control': 'off',
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
    })
  })
})

describe('hardenPreviewAttach', () => {
  it('removes every way a guest could get a preload, Node, popups or dialogs', () => {
    const prefs = {
      preload: '/evil/preload.js',
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    } as Electron.WebPreferences
    const params: Record<string, string> = {
      src: 'ostia-preview://x/',
      partition: 'ostia-preview-n',
      preload: 'file:///evil/preload.js',
      allowpopups: 'true',
      nodeintegration: 'true',
      webpreferences: 'contextIsolation=no',
      blinkfeatures: 'SharedArrayBuffer',
      disableblinkfeatures: 'Sandbox',
      plugins: 'true',
      disablewebsecurity: 'true',
    }
    Object.assign(prefs, {
      experimentalFeatures: true,
      plugins: true,
      allowRunningInsecureContent: true,
      enableBlinkFeatures: 'SharedArrayBuffer',
    })
    hardenPreviewAttach(prefs, params)
    expect(prefs).toMatchObject({
      preload: undefined,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      disableDialogs: true,
      autoplayPolicy: 'user-gesture-required',
      transparent: false,
      experimentalFeatures: false,
      plugins: false,
      allowRunningInsecureContent: false,
      enableBlinkFeatures: undefined,
      disableBlinkFeatures: undefined,
    })
    expect(Object.keys(params).sort()).toEqual(['partition', 'src'])
  })
})

type Handler = (...args: never[]) => unknown

class FakeSession implements PreviewSession {
  serve: ((request: Request) => Promise<Response>) | null = null
  filter: ((details: { url: string }, callback: (r: { cancel: boolean }) => void) => void) | null =
    null
  proxy: { proxyRules: string; proxyBypassRules: string } | null = null
  request: ((wc: unknown, permission: string, cb: (granted: boolean) => void) => void) | null = null
  check: ((wc: unknown, permission: string) => boolean) | null = null
  download: ((event: { preventDefault: () => void }) => void) | null = null
  cleared = 0
  protocol = {
    handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => {
      this.serve = handler
    },
  }
  webRequest = {
    onBeforeRequest: (listener: NonNullable<FakeSession['filter']>) => {
      this.filter = listener
    },
  }
  setProxy = async (config: { proxyRules: string; proxyBypassRules: string }): Promise<void> => {
    this.proxy = config
  }
  setPermissionRequestHandler = (handler: NonNullable<FakeSession['request']>): void => {
    this.request = handler
  }
  setPermissionCheckHandler = (handler: NonNullable<FakeSession['check']>): void => {
    this.check = handler
  }
  on = (_event: 'will-download', listener: NonNullable<FakeSession['download']>): void => {
    this.download = listener
  }
  clearStorageData = async (): Promise<void> => {
    this.cleared += 1
  }
  cancels(url: string): boolean {
    let cancelled = false
    this.filter?.({ url }, (r) => {
      cancelled = r.cancel
    })
    return cancelled
  }
  grants(permission: string): boolean {
    let granted = true
    this.request?.(null, permission, (g) => {
      granted = g
    })
    return granted && this.check?.(null, permission) === true
  }
}

class FakeGuest implements PreviewGuest {
  static next = 100
  id = FakeGuest.next++
  pid = 5000 + this.id
  destroyed = false
  killed = 0
  reloads = 0
  answers = true
  popups: (() => { action: 'deny' }) | null = null
  webrtc: string | null = null
  throttled: boolean | null = null
  attached = false
  lifecycle: string[] = []
  debugger = {
    isAttached: (): boolean => this.attached,
    attach: (): void => {
      this.attached = true
    },
    sendCommand: async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      expect(method).toBe('Emulation.setScriptExecutionDisabled')
      this.lifecycle.push(params?.value === true ? 'paused' : 'running')
      return {}
    },
  }
  listeners = new Map<string, Handler[]>()
  constructor(readonly session: unknown) {}
  isDestroyed = (): boolean => this.destroyed
  getOSProcessId = (): number => this.pid
  reload = (): void => {
    this.reloads += 1
  }
  executeJavaScript = (code: string): Promise<unknown> => {
    expect(code).toBe('0')
    return this.answers ? Promise.resolve(0) : new Promise(() => {})
  }
  forcefullyCrashRenderer = (): void => {
    this.killed += 1
  }
  setWindowOpenHandler = (handler: () => { action: 'deny' }): void => {
    this.popups = handler
  }
  setWebRTCIPHandlingPolicy = (policy: string): void => {
    this.webrtc = policy
  }
  setBackgroundThrottling = (allowed: boolean): void => {
    this.throttled = allowed
  }
  on = (event: string, listener: Handler): void => {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...(args as never[]))
  }
}

const builds: PreviewSource[] = []
let inputsOf = (source: PreviewSource): string[] => [source.file]

function watcherOf(dir: string): FSWatcher {
  const { calls, results } = vi.mocked(watch).mock
  const index = calls.findLastIndex((call) => call[0] === dir)
  const result = results[index]
  if (index < 0 || result.type !== 'return') throw new Error(`${dir} not watched`)
  return result.value
}

async function armed(watcher: FSWatcher, dir: string): Promise<void> {
  const probes: string[] = []
  watcher.on('change', (_kind, name) => probes.push(String(name)))
  for (let i = 0; i < 200 && probes.length === 0; i++) {
    writeFileSync(join(dir, `.probe-${i}`), '1')
    await new Promise((written) => setTimeout(written, 10))
  }
  expect(probes).not.toEqual([])
}

interface Rig {
  host: PreviewHost
  sessions: Map<string, FakeSession>
  events: PreviewEvent[]
  clock: { now: number }
  processes: ProcessUse[]
  open: (paneId?: string, path?: string, windowId?: string) => PreviewOpened
  attach: (opened: PreviewOpened) => FakeGuest
  sessionOf: (opened: PreviewOpened) => FakeSession
  advance: (ms: number) => Promise<void>
}

function rig(): Rig {
  const sessions = new Map<string, FakeSession>()
  const events: PreviewEvent[] = []
  const clock = { now: 1_000_000 }
  const processes: ProcessUse[] = []
  const host = new PreviewHost({
    sessionOf: (partition) => {
      const session = new FakeSession()
      sessions.set(partition, session)
      return session
    },
    confine: (path) => (path.startsWith(`${base}/`) ? path : null),
    servesFolder: (dir) => dir === folder || dir.startsWith(`${folder}/`),
    build: async (source) => {
      builds.push(source)
      return { document: `<!doctype html><title>${source.file}</title>`, inputs: inputsOf(source) }
    },
    ownsPane: (windowId, paneId) => paneId.startsWith(`${windowId}:`),
    send: (_windowId, event) => events.push(event),
    processes: () => processes,
    now: () => clock.now,
  })
  const open = (paneId = '1:p1', path = page, windowId = '1'): PreviewOpened => {
    const opened = host.open(windowId, paneId, path)
    if (!opened) throw new Error('not opened')
    return opened
  }
  const sessionOf = (opened: PreviewOpened): FakeSession => {
    const session = sessions.get(opened.partition)
    if (!session) throw new Error('no session')
    return session
  }
  return {
    host,
    sessions,
    events,
    clock,
    processes,
    open,
    sessionOf,
    attach: (opened) => {
      const guest = new FakeGuest(sessionOf(opened))
      expect(host.adopt(guest)).toBe(true)
      return guest
    },
    advance: async (ms) => {
      for (let passed = 0; passed < ms; passed += 1000) {
        clock.now += 1000
        host.tick()
        await Promise.resolve()
      }
    },
  }
}

describe('PreviewHost', () => {
  let r: Rig

  beforeEach(() => {
    inputsOf = (source) => [source.file]
    r = rig()
  })

  afterEach(() => {
    vi.useRealTimers()
    r.host.dispose()
  })

  it('opens an HTML file of the asking window on its own in-memory partition', () => {
    const opened = r.open()
    expect(opened.partition).toMatch(/^ostia-preview-[0-9a-f]{24}$/)
    expect(opened.partition.startsWith('persist:')).toBe(false)
    expect(opened.url).toBe(`ostia-preview://${opened.id}/`)
    const other = r.open('1:p2')
    expect(other.partition).not.toBe(opened.partition)
  })

  it('opens nothing for another window’s pane, a non-HTML file or a path outside what the window may read', () => {
    expect(r.host.open('2', '1:p1', page)).toBeNull()
    expect(r.host.open('1', '1:p1', join(folder, 'data.json'))).toBeNull()
    expect(r.host.open('1', '1:p1', '/etc/hosts.html')).toBeNull()
    expect(r.host.open('1', '1:p1', join(folder, 'missing.html'))).toBeNull()
    symlinkSync(join(base, 'outside.txt'), join(folder, 'alias.html'))
    expect(r.host.open('1', '1:p1', join(folder, 'alias.html'))).toBeNull()
    expect(r.sessions.size).toBe(0)
  })

  it('cancels every request that is not the preview scheme and names the host in the strip', () => {
    const opened = r.open()
    const session = r.sessionOf(opened)
    expect(session.cancels(`${opened.url}data.json`)).toBe(false)
    for (const url of [
      'http://127.0.0.1:4000/x',
      'https://example.com/',
      'ws://127.0.0.1:4000/',
      'file:///etc/passwd',
    ]) {
      expect(session.cancels(url), url).toBe(true)
    }
    expect(r.events.filter((e) => e.type === 'error').map((e) => e.error)).toEqual([
      { kind: 'blocked', message: '127.0.0.1:4000' },
      { kind: 'blocked', message: 'example.com' },
      { kind: 'blocked', message: '127.0.0.1:4000' },
      { kind: 'blocked', message: 'file' },
    ])
  })

  it('points the session at a dead proxy that also covers loopback', () => {
    expect(r.sessionOf(r.open()).proxy).toEqual({
      proxyRules: 'http://127.0.0.1:9',
      proxyBypassRules: '<-loopback>',
    })
  })

  it('denies every permission, except a clipboard write right after the human’s input', () => {
    const opened = r.open()
    const session = r.sessionOf(opened)
    const guest = r.attach(opened)
    for (const permission of [
      'clipboard-read',
      'clipboard-sanitized-write',
      'media',
      'geolocation',
      'notifications',
      'fullscreen',
      'openExternal',
      'fileSystem',
    ]) {
      expect(session.grants(permission), permission).toBe(false)
    }
    guest.emit('input-event', {}, { type: 'mouseMove' })
    expect(session.grants('clipboard-sanitized-write')).toBe(false)
    guest.emit('input-event', {}, { type: 'mouseDown' })
    expect(session.grants('clipboard-sanitized-write')).toBe(true)
    expect(session.grants('clipboard-read')).toBe(false)
    r.clock.now += 5_001
    expect(session.grants('clipboard-sanitized-write')).toBe(false)
  })

  it('cancels downloads', () => {
    const prevented = vi.fn()
    r.sessionOf(r.open()).download?.({ preventDefault: prevented })
    expect(prevented).toHaveBeenCalledOnce()
  })

  it('accepts only its own guest: the exact URL, partition and window', () => {
    const opened = r.open()
    expect(r.host.acceptsAttach(opened.partition, opened.url, '1')).toBe(true)
    expect(r.host.acceptsAttach(opened.partition, opened.url, '2')).toBe(false)
    expect(r.host.acceptsAttach(opened.partition, 'https://example.com/', '1')).toBe(false)
    expect(r.host.acceptsAttach(opened.partition, `${opened.url}other.html`, '1')).toBe(false)
    expect(r.host.acceptsAttach('ostia-preview-unknown', opened.url, '1')).toBe(false)
  })

  it('leaves guests of other sessions alone', () => {
    r.open()
    expect(r.host.adopt(new FakeGuest(new FakeSession()))).toBe(false)
  })

  it('kills a second guest on a session that already has one', () => {
    const opened = r.open()
    r.attach(opened)
    const stray = new FakeGuest(r.sessionOf(opened))
    expect(r.host.adopt(stray)).toBe(true)
    expect(stray.killed).toBe(1)
  })

  it('denies popups, stops navigation and redirects, and reports only a link the human clicked', () => {
    const opened = r.open()
    const guest = r.attach(opened)
    expect(guest.popups?.()).toEqual({ action: 'deny' })
    expect(guest.webrtc).toBe('disable_non_proxied_udp')
    expect(guest.throttled).toBe(true)
    const unasked = { preventDefault: vi.fn() }
    guest.emit('will-navigate', unasked, 'https://example.com/by-script')
    expect(unasked.preventDefault).toHaveBeenCalledOnce()
    expect(r.events).toEqual([])
    guest.emit('input-event', {}, { type: 'mouseDown' })
    const navigate = { preventDefault: vi.fn() }
    guest.emit('will-navigate', navigate, 'https://example.com/next')
    const local = { preventDefault: vi.fn() }
    guest.emit('will-navigate', local, `${opened.url}other.html`)
    const redirect = { preventDefault: vi.fn() }
    guest.emit('will-redirect', redirect, 'https://example.com/')
    expect(navigate.preventDefault).toHaveBeenCalledOnce()
    expect(local.preventDefault).toHaveBeenCalledOnce()
    expect(redirect.preventDefault).toHaveBeenCalledOnce()
    expect(r.events).toEqual([{ id: opened.id, type: 'link', url: 'https://example.com/next' }])
  })

  it('passes on console errors only, named after the previewed file', () => {
    const opened = r.open()
    const guest = r.attach(opened)
    guest.emit('console-message', { level: 'info', message: 'hello' })
    guest.emit('console-message', { level: 'warning', message: 'careful' })
    guest.emit('console-message', {
      level: 'error',
      message: 'Uncaught Error: boom',
      lineNumber: 7,
      sourceId: opened.url,
    })
    guest.emit('console-message', {
      level: 'error',
      message: 'Uncaught ReferenceError: x is not defined',
      lineNumber: 3,
      sourceId: opened.url,
    })
    guest.emit('console-message', {
      level: 'error',
      message:
        'Refused to connect to \'http://127.0.0.1:4000/a\' because it violates the following Content Security Policy directive: "connect-src ostia-preview:".',
    })
    expect(r.events).toEqual([
      {
        id: opened.id,
        type: 'error',
        error: { kind: 'error', message: 'Uncaught Error: boom', line: 7, source: 'page.html' },
      },
      {
        id: opened.id,
        type: 'error',
        error: {
          kind: 'error',
          message: 'Uncaught ReferenceError: x is not defined',
          line: 3,
          source: 'page.html',
        },
      },
      { id: opened.id, type: 'error', error: { kind: 'blocked', message: '127.0.0.1:4000' } },
    ])
  })

  it('PRT-C28 serves the built document at / and nothing else', async () => {
    const app = join(folder, 'App.tsx')
    writeFileSync(app, 'export default () => null')
    const opened = r.open('1:p1', app)
    const serve = r.sessionOf(opened).serve as (request: Request) => Promise<Response>
    const ok = await serve(new Request(opened.url))
    expect(ok.status).toBe(200)
    expect(r.events).toEqual([{ id: opened.id, type: 'loading' }])
    expect(await ok.text()).toBe(`<!doctype html><title>${app}</title>`)
    expect(builds.at(-1)).toEqual({ file: app, root: folder })
    for (const path of [
      'data.json',
      'runtime/react.js',
      'App.tsx',
      '__ostia_shell.js',
      '../outside.txt',
    ]) {
      expect((await serve(new Request(`${opened.url}${path}`))).status, path).toBe(404)
    }
    expect((await serve(new Request('ostia-preview://someone-else/'))).status).toBe(404)
    expect((await serve(new Request(opened.url, { method: 'POST', body: 'x' }))).status).toBe(405)
  })

  it('builds a page outside an artifact folder with no folder to read from', async () => {
    const elsewhere = join(base, 'home')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'x.html'), '<!doctype html><title>x</title>')
    const opened = r.open('1:p1', join(elsewhere, 'x.html'))
    const serve = r.sessionOf(opened).serve as (request: Request) => Promise<Response>
    expect((await serve(new Request(opened.url))).status).toBe(200)
    expect(builds.at(-1)).toEqual({ file: join(elsewhere, 'x.html'), root: null })
  })

  it('PRT-C29 reloads the preview when a file the build imported changes', async () => {
    const app = join(folder, 'App.tsx')
    const chart = join(folder, 'assets', 'Chart.tsx')
    writeFileSync(app, "import Chart from './assets/Chart'")
    writeFileSync(chart, 'export default () => null')
    inputsOf = () => [app, chart]
    const opened = r.open('1:p1', app)
    const guest = r.attach(opened)
    const serve = r.sessionOf(opened).serve as (request: Request) => Promise<Response>
    await serve(new Request(opened.url))
    const assets = watcherOf(join(folder, 'assets'))
    await armed(watcherOf(folder), folder)
    await armed(assets, join(folder, 'assets'))
    await new Promise((settled) => setTimeout(settled, PREVIEW_LIMITS.reloadDebounceMs + 100))
    const before = guest.reloads
    const names: string[] = []
    assets.on('change', (_kind, name) => names.push(String(name)))
    writeFileSync(join(folder, 'assets', 'unrelated.txt'), 'x')
    await vi.waitFor(() => expect(names).toContain('unrelated.txt'), { timeout: 3000 })
    await new Promise((settled) => setTimeout(settled, PREVIEW_LIMITS.reloadDebounceMs + 100))
    expect(guest.reloads).toBe(before)
    writeFileSync(chart, 'export default () => 1')
    await vi.waitFor(() => expect(guest.reloads).toBe(before + 1), { timeout: 3000 })
  })

  it('says a page is not responding after 5 s, then stops and kills it at 15 s', async () => {
    const opened = r.open()
    const guest = r.attach(opened)
    guest.answers = false
    await r.advance(5_000)
    expect(r.events).toEqual([])
    await r.advance(1_000)
    expect(r.events).toEqual([{ id: opened.id, type: 'vitals', responding: false, busy: false }])
    await r.advance(9_000)
    expect(guest.killed).toBe(0)
    await r.advance(1_000)
    expect(r.events.at(-1)).toEqual({ id: opened.id, type: 'stopped', reason: 'unresponsive' })
    expect(guest.killed).toBe(1)
    expect(r.host.acceptsAttach(opened.partition, opened.url, '1')).toBe(false)
  })

  it('keeps a page that answers, however long it runs', async () => {
    const opened = r.open()
    const guest = r.attach(opened)
    await r.advance(120_000)
    expect(r.events).toEqual([])
    expect(guest.killed).toBe(0)
    expect(r.host.acceptsAttach(opened.partition, opened.url, '1')).toBe(true)
  })

  it('stops a page whose process is over 512 MiB', async () => {
    const opened = r.open()
    const guest = r.attach(opened)
    r.processes.push({ pid: guest.pid, memoryBytes: 512 * MIB, cpuPercent: 5 })
    r.host.measure()
    await r.advance(1_000)
    expect(r.events).toEqual([])
    r.processes[0].memoryBytes = 513 * MIB
    r.host.measure()
    await r.advance(1_000)
    expect(r.events).toEqual([{ id: opened.id, type: 'stopped', reason: 'memory' }])
    expect(guest.killed).toBe(1)
  })

  it('offers Stop for a visible page that kept a core busy for 30 s, without killing it', async () => {
    const opened = r.open()
    const guest = r.attach(opened)
    r.processes.push({ pid: guest.pid, memoryBytes: 50 * MIB, cpuPercent: 130 })
    r.host.measure()
    await r.advance(29_000)
    expect(r.events).toEqual([])
    await r.advance(1_000)
    expect(r.events).toEqual([{ id: opened.id, type: 'vitals', responding: true, busy: true }])
    expect(guest.killed).toBe(0)
  })

  it('destroys a hidden page after 60 s, and a page shown again in time stays', async () => {
    const hidden = r.open('1:p1')
    const hiddenGuest = r.attach(hidden)
    const back = r.open('1:p2')
    r.attach(back)
    r.host.shown('1', hidden.id, false)
    r.host.shown('1', back.id, false)
    await r.advance(30_000)
    r.host.shown('1', back.id, true)
    await r.advance(29_000)
    expect(r.events).toEqual([])
    await r.advance(1_000)
    expect(r.events).toEqual([{ id: hidden.id, type: 'stopped', reason: 'hidden' }])
    expect(hiddenGuest.killed).toBe(1)
    await r.advance(120_000)
    expect(r.events).toHaveLength(1)
  })

  it('pauses a hidden page’s scripts once it has answered, and lets them run when it is shown again', async () => {
    const opened = r.open()
    const guest = r.attach(opened)
    await r.advance(3_000)
    expect(guest.lifecycle).toEqual([])
    r.host.shown('1', opened.id, false)
    await r.advance(2_000)
    expect(guest.lifecycle).toEqual(['paused'])
    await r.advance(20_000)
    expect(r.events).toEqual([])
    r.host.shown('1', opened.id, true)
    await r.advance(2_000)
    expect(guest.lifecycle).toEqual(['paused', 'running'])
    await r.advance(120_000)
    expect(r.events).toEqual([])
    expect(guest.killed).toBe(0)
  })

  it('stops a hidden page that never answers instead of pausing it', async () => {
    const opened = r.open()
    const guest = r.attach(opened)
    guest.answers = false
    r.host.shown('1', opened.id, false)
    await r.advance(6_000)
    expect(guest.lifecycle).toEqual([])
    expect(r.events).toEqual([{ id: opened.id, type: 'stopped', reason: 'unresponsive' }])
    expect(guest.killed).toBe(1)
  })

  it('holds a reload for a paused page until it is shown', async () => {
    const opened = r.open()
    const guest = r.attach(opened)
    const serve = r.sessionOf(opened).serve as (request: Request) => Promise<Response>
    await serve(new Request(opened.url))
    const changed = vi.mocked(watch).mock.lastCall?.[1]
    if (!changed) throw new Error('not watched')
    r.host.shown('1', opened.id, false)
    await r.advance(2_000)
    expect(guest.lifecycle).toEqual(['paused'])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    changed('change', 'page.html')
    vi.advanceTimersByTime(PREVIEW_LIMITS.reloadDebounceMs)
    expect(guest.reloads).toBe(0)
    r.host.shown('1', opened.id, true)
    await vi.waitFor(() => expect(guest.reloads).toBe(1))
  })

  it('ignores a visibility change sent from another window', async () => {
    const opened = r.open()
    r.attach(opened)
    r.host.shown('2', opened.id, false)
    r.host.stopByHuman('2', opened.id)
    await r.advance(70_000)
    expect(r.events).toEqual([])
  })

  it('runs at most four previews per window, stopping the least recently shown', () => {
    const opened = [1, 2, 3, 4].map((n) => {
      r.clock.now += 10
      return r.open(`1:p${n}`)
    })
    r.clock.now += 10
    r.host.shown('1', opened[0].id, false)
    r.host.shown('1', opened[0].id, true)
    r.clock.now += 10
    const otherWindow = r.host.open('2', '2:p1', page)
    expect(otherWindow).not.toBeNull()
    expect(r.events).toEqual([])
    r.open('1:p5')
    expect(r.events).toEqual([{ id: opened[1].id, type: 'stopped', reason: 'limit' }])
  })

  it('stops on the human’s Stop and when the page’s process ends', () => {
    const first = r.open('1:p1')
    const firstGuest = r.attach(first)
    r.host.stopByHuman('1', first.id)
    expect(firstGuest.killed).toBe(1)
    const second = r.open('1:p2')
    const secondGuest = r.attach(second)
    secondGuest.emit('render-process-gone', {}, { reason: 'oom' })
    expect(r.events).toEqual([
      { id: first.id, type: 'stopped', reason: 'human' },
      { id: second.id, type: 'stopped', reason: 'crashed' },
    ])
  })

  it('reuses a closed pane’s session for the next preview after clearing it', () => {
    const first = r.open('1:p1')
    r.host.paneClosed('1:p1')
    expect(r.sessionOf(first).cleared).toBe(1)
    const next = r.open('1:p9')
    expect(next.partition).toBe(first.partition)
    expect(next.id).not.toBe(first.id)
    expect(r.sessions.size).toBe(1)
    expect(r.host.acceptsAttach(first.partition, first.url, '1')).toBe(false)
  })

  it('PRT-C55 names the live guest of a preview only to its own window, and to no one once it stopped', () => {
    const opened = r.open()
    const guest = r.attach(opened)
    expect(r.host.captureGuestId('1', '1:p1')).toBe(guest.id)
    expect(r.host.captureGuestId('2', '1:p1')).toBeNull()
    expect(r.host.captureGuestId('1', '1:other')).toBeNull()
    r.host.stopByHuman('1', opened.id)
    expect(r.host.captureGuestId('1', '1:p1')).toBeNull()
  })

  it('PRT-C79 remembers the theme each window previews with', () => {
    const dark = { dark: true, vars: { '--ostia-bg': '#000000' } }
    const light = { dark: false, vars: { '--ostia-bg': '#ffffff' } }
    r.host.open('1', '1:p1', page, dark)
    r.host.open('2', '2:p2', page, light)
    expect(r.host.themeOf('1')).toEqual(dark)
    expect(r.host.themeOf('2')).toEqual(light)
    expect(r.host.themeOf('3')).toEqual({ dark: false, vars: {} })
  })
})
