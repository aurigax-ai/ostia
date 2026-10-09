import { execFileSync } from 'node:child_process'
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

import {
  PREVIEW_LIMITS,
  PREVIEW_PAGE_CSP,
  type PreviewEvent,
  type PreviewOpened,
} from '../shared/htmlPreview'
import {
  type PreviewGuest,
  PreviewHost,
  type PreviewSession,
  type ProcessUse,
  hardenPreviewAttach,
  previewHeaders,
  readPreviewFile,
  readRegularFile,
  resolvePreviewFile,
} from './htmlPreview'

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
  mkdirSync(join(base, 'runtime'))
  writeFileSync(join(base, 'runtime', 'react.js'), 'export default {}')
  writeFileSync(join(base, 'runtime', 'secret.js'), 'not in the list')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('resolvePreviewFile', () => {
  const source = (): { file: string; root: string | null } => ({ file: page, root: folder })

  it('serves the page itself at /', () => {
    expect(resolvePreviewFile(source(), '/')).toMatchObject({ ok: true, path: page })
  })

  it('serves regular files beside the page and below', () => {
    expect(resolvePreviewFile(source(), '/data.json')).toMatchObject({
      ok: true,
      path: join(folder, 'data.json'),
      size: 7,
    })
    expect(resolvePreviewFile(source(), '/assets/app.js')).toMatchObject({ ok: true })
    expect(resolvePreviewFile(source(), '/assets/a%70p.js')).toMatchObject({ ok: true })
  })

  it('refuses a path that leaves the folder', () => {
    for (const path of ['/../outside.txt', '/assets/../../outside.txt', '/%2e%2e/outside.txt']) {
      expect(resolvePreviewFile(source(), path), path).toEqual({ ok: false, status: 404 })
    }
  })

  it('refuses a symlink, and a file reached through a symlinked folder that leaves', () => {
    symlinkSync(join(base, 'outside.txt'), join(folder, 'link.txt'))
    symlinkSync(base, join(folder, 'up'))
    expect(resolvePreviewFile(source(), '/link.txt')).toEqual({ ok: false, status: 404 })
    expect(resolvePreviewFile(source(), '/up/outside.txt')).toEqual({ ok: false, status: 404 })
  })

  it('refuses credential paths, folders, missing files and bad escapes', () => {
    mkdirSync(join(folder, '.ssh'))
    writeFileSync(join(folder, '.ssh', 'id_ed25519'), 'key')
    writeFileSync(join(folder, '.env'), 'A=1')
    writeFileSync(join(folder, '.env.local'), 'A=1')
    for (const path of ['/.ssh/id_ed25519', '/.env', '/.env.local', '/assets', '/nope.js']) {
      expect(resolvePreviewFile(source(), path), path).toEqual({ ok: false, status: 404 })
    }
    expect(resolvePreviewFile(source(), '/%E0%A4%A')).toEqual({ ok: false, status: 400 })
  })

  it('serves only the page when its folder is not a file root', () => {
    const lone = { file: page, root: null }
    expect(resolvePreviewFile(lone, '/')).toMatchObject({ ok: true })
    expect(resolvePreviewFile(lone, '/data.json')).toEqual({ ok: false, status: 404 })
  })
})

describe('readPreviewFile', () => {
  const source = (): { file: string; root: string | null } => ({ file: page, root: folder })

  it('reads the file it resolved, within what is left of the load', async () => {
    const read = await readPreviewFile(source(), '/data.json', 100)
    expect(read.ok && read.body.toString()).toBe('{"a":1}')
    expect(await readPreviewFile(source(), '/data.json', 6)).toEqual({ ok: false, status: 413 })
    expect(await readPreviewFile(source(), '/../outside.txt', 100)).toEqual({
      ok: false,
      status: 404,
    })
  })

  it('never waits on a FIFO put where a file was, also when it appears after the check', async () => {
    const pipe = join(folder, 'pipe.json')
    execFileSync('mkfifo', [pipe])
    const started = Date.now()
    expect(await readPreviewFile(source(), '/pipe.json', 100)).toEqual({ ok: false, status: 404 })
    expect(await readRegularFile(pipe, 100)).toEqual({ ok: false, status: 404 })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('refuses a page that became a symlink after the preview was opened', async () => {
    rmSync(page)
    symlinkSync(join(base, 'outside.txt'), page)
    expect(await readPreviewFile(source(), '/', 100)).toEqual({ ok: false, status: 404 })
  })

  it('refuses a file whose folder was replaced by a symlink to somewhere else', async () => {
    const elsewhere = join(base, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'app.js'), 'secret')
    rmSync(join(folder, 'assets'), { recursive: true })
    symlinkSync(elsewhere, join(folder, 'assets'))
    expect(await readPreviewFile(source(), '/assets/app.js', 100)).toEqual({
      ok: false,
      status: 404,
    })
  })
})

describe('previewHeaders', () => {
  it('carries the sandbox policy and an open CORS header on every response', () => {
    expect(previewHeaders('/a/page.html')).toMatchObject({
      'x-dns-prefetch-control': 'off',
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': PREVIEW_PAGE_CSP,
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    })
    expect(previewHeaders('/a/app.mjs')['content-type']).toBe('text/javascript; charset=utf-8')
    expect(previewHeaders('/a/unknown.bin')['content-type']).toBe('application/octet-stream')
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
    ownsPane: (windowId, paneId) => paneId.startsWith(`${windowId}:`),
    send: (_windowId, event) => events.push(event),
    processes: () => processes,
    runtimeDir: () => join(base, 'runtime'),
    compile: async (file, source) => `/* compiled ${file} */${source.toString().length}`,
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
    r = rig()
  })

  afterEach(() => {
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

  it('passes on console errors only, with the file-relative source', () => {
    const opened = r.open()
    const guest = r.attach(opened)
    guest.emit('console-message', { level: 'info', message: 'hello' })
    guest.emit('console-message', { level: 'warning', message: 'careful' })
    guest.emit('console-message', {
      level: 'error',
      message: 'Uncaught Error: boom',
      lineNumber: 7,
      sourceId: `${opened.url}assets/app.js`,
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
        error: { kind: 'error', message: 'Uncaught Error: boom', line: 7, source: 'assets/app.js' },
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

  it('serves the page with the policy, and nothing to another load id or method', async () => {
    const opened = r.open()
    const serve = r.sessionOf(opened).serve as (request: Request) => Promise<Response>
    const ok = await serve(new Request(opened.url))
    expect(ok.status).toBe(200)
    expect(r.events).toEqual([{ id: opened.id, type: 'loading' }])
    expect(ok.headers.get('content-security-policy')).toBe(PREVIEW_PAGE_CSP)
    expect(await ok.text()).toContain('<title>t</title>')
    const data = await serve(new Request(`${opened.url}data.json`))
    expect(await data.json()).toEqual({ a: 1 })
    expect(data.headers.get('access-control-allow-origin')).toBe('*')
    expect((await serve(new Request('ostia-preview://someone-else/'))).status).toBe(404)
    expect((await serve(new Request(`${opened.url}../outside.txt`))).status).toBe(404)
    expect((await serve(new Request(opened.url, { method: 'POST', body: 'x' }))).status).toBe(405)
  })

  it('serves a page outside an artifact folder alone: no sibling, whatever folder it sits in', async () => {
    const elsewhere = join(base, 'home')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'x.html'), '<!doctype html><title>x</title>')
    writeFileSync(join(elsewhere, 'notes.txt'), 'private notes')
    const opened = r.open('1:p1', join(elsewhere, 'x.html'))
    const serve = r.sessionOf(opened).serve as (request: Request) => Promise<Response>
    expect((await serve(new Request(opened.url))).status).toBe(200)
    expect((await serve(new Request(`${opened.url}notes.txt`))).status).toBe(404)
    expect((await serve(new Request(`${opened.url}x.html`))).status).toBe(404)
  })

  it('serves only the listed runtime files, to pages and components alike', async () => {
    const opened = r.open()
    const serve = r.sessionOf(opened).serve as (request: Request) => Promise<Response>
    const react = await serve(new Request(`${opened.url}runtime/react.js`))
    expect(react.status).toBe(200)
    expect(react.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await react.text()).toBe('export default {}')
    for (const name of ['secret.js', '../outside.txt', 'recharts.js', 'react.js/..', '']) {
      const res = await serve(new Request(`${opened.url}runtime/${name}`))
      expect(res.status, name).toBe(404)
    }
  })

  it('serves a component through the shell page with a fresh nonce and no inline scripts', async () => {
    const app = join(folder, 'App.tsx')
    writeFileSync(app, 'export default function App() { return null }')
    writeFileSync(join(folder, 'Chart.tsx'), 'export const Chart = () => null')
    const opened = r.open('1:p1', app)
    const serve = r.sessionOf(opened).serve as (request: Request) => Promise<Response>
    const first = await serve(new Request(opened.url))
    const second = await serve(new Request(opened.url))
    const csp = first.headers.get('content-security-policy') ?? ''
    const nonce = /script-src ostia-preview: 'nonce-([^']+)'/.exec(csp)?.[1]
    expect(nonce).toBeTruthy()
    expect(csp).not.toContain("script-src ostia-preview: 'unsafe-inline'")
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).toContain('sandbox allow-scripts')
    expect(csp).not.toContain('allow-same-origin')
    expect(second.headers.get('content-security-policy')).not.toBe(csp)
    const html = await first.text()
    expect(html).toContain(`<script type="importmap" nonce="${nonce}">`)
    expect(html).toContain('"react":"/runtime/react.js"')
    expect(html).not.toContain('export default function App')
    expect(html.match(/<script(?![^>]*nonce=)/g)).toBeNull()

    const shell = await serve(new Request(`${opened.url}__ostia_shell.js`))
    expect(await shell.text()).toContain("import('/__ostia_entry.js')".replace(/'/g, '"'))
    const entry = await serve(new Request(`${opened.url}__ostia_entry.js`))
    expect(entry.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await entry.text()).toBe('/* compiled App.tsx */45')
    const bare = await serve(new Request(`${opened.url}Chart`))
    expect(await bare.text()).toBe('/* compiled Chart.tsx */31')
    expect((await serve(new Request(`${opened.url}Missing`))).status).toBe(404)
    expect((await serve(new Request(`${opened.url}data.json`))).headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
  })

  it('keeps the shell for components: an HTML page never gets it', async () => {
    const opened = r.open()
    const serve = r.sessionOf(opened).serve as (request: Request) => Promise<Response>
    expect((await serve(new Request(`${opened.url}__ostia_shell.js`))).status).toBe(404)
    expect((await serve(new Request(`${opened.url}__ostia_entry.js`))).status).toBe(404)
  })

  it('serves at most 16 MiB per load and starts counting again with the page', async () => {
    const big = join(folder, 'big.bin')
    const fd = openSync(big, 'w')
    ftruncateSync(fd, PREVIEW_LIMITS.loadBytes - 10)
    closeSync(fd)
    const opened = r.open()
    const serve = r.sessionOf(opened).serve as (request: Request) => Promise<Response>
    expect((await serve(new Request(`${opened.url}big.bin`))).status).toBe(200)
    expect((await serve(new Request(`${opened.url}data.json`))).status).toBe(200)
    expect((await serve(new Request(`${opened.url}assets/app.js`))).status).toBe(413)
    expect((await serve(new Request(opened.url))).status).toBe(200)
    expect((await serve(new Request(`${opened.url}assets/app.js`))).status).toBe(200)
  })

  it('reloads the guest when a file it loaded changes', async () => {
    const opened = r.open()
    const guest = r.attach(opened)
    const serve = r.sessionOf(opened).serve as (request: Request) => Promise<Response>
    await serve(new Request(opened.url))
    await serve(new Request(`${opened.url}data.json`))
    writeFileSync(join(folder, 'unrelated.txt'), 'x')
    writeFileSync(join(folder, 'data.json'), '{"a":2}')
    await vi.waitFor(() => expect(guest.reloads).toBe(1), { timeout: 3000 })
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
    r.host.shown('1', opened.id, false)
    await r.advance(2_000)
    expect(guest.lifecycle).toEqual(['paused'])
    writeFileSync(page, '<!doctype html><title>changed</title>')
    await new Promise((resolve) => setTimeout(resolve, 700))
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
})
