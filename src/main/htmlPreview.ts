import { randomBytes } from 'node:crypto'
import { constants, type FSWatcher, type Stats, lstatSync, realpathSync, watch } from 'node:fs'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { ipcMain } from 'electron'
import { RUNTIME_PREFIX, runtimeFiles } from '../shared/artifactRuntime'
import {
  PREVIEW_LIMITS,
  PREVIEW_PAGE_CSP,
  PREVIEW_SCHEME,
  type PreviewError,
  type PreviewEvent,
  type PreviewOpened,
  type PreviewStopReason,
  type PreviewTheme,
  SHELL_MODULE_PATH,
  allowsPreviewRequest,
  blockedByPolicy,
  blockedHost,
  isComponentPath,
  isPreviewPath,
  normalizePreviewTheme,
  previewPartition,
  shellCsp,
} from '../shared/htmlPreview'
import { compiles } from './artifactCompiler'
import { isHiddenFromPhone } from './gateway/workspaceFiles'
import { busySince, previewVerdict, previewsOverCap } from './previewLimits'
import { ENTRY_MODULE_PATH, shellModule, shellPage } from './previewShell'

const PING_MS = 1_000
const METRICS_MS = 5_000
const GESTURE_MS = 5_000
const MESSAGE_MAX = 2_000
const WATCHED_DIRS_MAX = 16
const DEAD_PROXY = { proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '<-loopback>' }
const GESTURE_INPUTS = new Set(['mouseDown', 'keyDown', 'touchStart'])
const CLIPBOARD_WRITE = 'clipboard-sanitized-write'
const DEBUGGER_PROTOCOL = '1.3'
const PAUSE_SCRIPTS = 'Emulation.setScriptExecutionDisabled'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

export function previewMime(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export function previewHeaders(path: string): Record<string, string> {
  return typedHeaders(previewMime(path))
}

export function typedHeaders(type: string): Record<string, string> {
  return {
    'content-type': type,
    'content-security-policy': PREVIEW_PAGE_CSP,
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-dns-prefetch-control': 'off',
  }
}

export interface PreviewSource {
  file: string
  root: string | null
}

const MODULE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js']
const SCRIPT_TYPE = 'text/javascript; charset=utf-8'
const PAGE_TYPE = 'text/html; charset=utf-8'

export type PreviewFile = { ok: true; path: string; size: number } | { ok: false; status: number }

function regularFileSize(path: string): number | null {
  try {
    const st = lstatSync(path)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

export function resolvePreviewFile(source: PreviewSource, pathname: string): PreviewFile {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { ok: false, status: 400 }
  }
  if (decoded === '/' || decoded === '') {
    const size = regularFileSize(source.file)
    return size === null ? { ok: false, status: 404 } : { ok: true, path: source.file, size }
  }
  if (!source.root || decoded.includes('\0')) return { ok: false, status: 404 }
  const lexical = join(source.root, decoded)
  const inside = relative(source.root, lexical)
  if (inside === '' || inside.startsWith('..') || isHiddenFromPhone(inside)) {
    return { ok: false, status: 404 }
  }
  const size = regularFileSize(lexical)
  if (size === null) return { ok: false, status: 404 }
  let folder: string
  try {
    folder = realpathSync(dirname(lexical))
  } catch {
    return { ok: false, status: 404 }
  }
  if (folder !== source.root && !folder.startsWith(`${source.root}${sep}`)) {
    return { ok: false, status: 404 }
  }
  const path = join(folder, basename(lexical))
  if (isHiddenFromPhone(relative(source.root, path))) return { ok: false, status: 404 }
  return { ok: true, path, size }
}

export type PreviewRead = { ok: true; path: string; body: Buffer } | { ok: false; status: number }

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

async function stillAt(path: string, opened: Stats): Promise<boolean> {
  try {
    return (await realpath(path)) === path && sameFile(await stat(path), opened)
  } catch {
    return false
  }
}

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

export async function readRegularFile(path: string, maxBytes: number): Promise<PreviewRead> {
  const handle = await open(path, READ_FLAGS).catch(() => null)
  if (!handle) return { ok: false, status: 404 }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !(await stillAt(path, opened))) return { ok: false, status: 404 }
    if (opened.size > maxBytes) return { ok: false, status: 413 }
    const body = Buffer.alloc(opened.size)
    let read = 0
    while (read < body.length) {
      const { bytesRead } = await handle.read(body, read, body.length - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { ok: true, path, body: body.subarray(0, read) }
  } catch {
    return { ok: false, status: 404 }
  } finally {
    await handle.close()
  }
}

export async function readPreviewFile(
  source: PreviewSource,
  pathname: string,
  maxBytes: number,
): Promise<PreviewRead> {
  const found = resolvePreviewFile(source, pathname)
  return found.ok ? readRegularFile(found.path, maxBytes) : found
}

export interface PreviewSession {
  protocol: {
    handle: (scheme: string, handler: (request: Request) => Promise<Response>) => void
  }
  webRequest: {
    onBeforeRequest: (
      listener: (details: { url: string }, callback: (r: { cancel: boolean }) => void) => void,
    ) => void
  }
  setProxy: (config: { proxyRules: string; proxyBypassRules: string }) => Promise<void>
  setPermissionRequestHandler: (
    handler: (wc: unknown, permission: string, callback: (granted: boolean) => void) => void,
  ) => void
  setPermissionCheckHandler: (handler: (wc: unknown, permission: string) => boolean) => void
  on: (event: 'will-download', listener: (event: { preventDefault: () => void }) => void) => void
  clearStorageData: () => Promise<void>
}

export interface PreviewGuest {
  id: number
  session: unknown
  isDestroyed: () => boolean
  getOSProcessId: () => number
  reload: () => void
  executeJavaScript: (code: string) => Promise<unknown>
  forcefullyCrashRenderer: () => void
  setWindowOpenHandler: (handler: () => { action: 'deny' }) => void
  setWebRTCIPHandlingPolicy: (policy: 'disable_non_proxied_udp') => void
  setBackgroundThrottling: (allowed: boolean) => void
  debugger: {
    isAttached: () => boolean
    attach: (protocolVersion?: string) => void
    sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  }
  // biome-ignore lint/suspicious/noExplicitAny: Electron's per-event listener signatures differ.
  on: (event: any, listener: (...args: any[]) => void) => unknown
}

export interface ProcessUse {
  pid: number
  memoryBytes: number
  cpuPercent: number
}

export interface PreviewHostDeps {
  sessionOf: (partition: string) => PreviewSession
  confine: (path: string) => string | null
  servesFolder: (dir: string) => boolean
  ownsPane: (windowId: string, paneId: string) => boolean
  send: (windowId: string, event: PreviewEvent) => void
  processes: () => ProcessUse[]
  runtimeDir: () => string
  compile: (file: string, source: Buffer) => Promise<string>
  now?: () => number
}

interface Slot {
  nonce: string
  partition: string
  session: PreviewSession
  live: Live | null
}

interface Live {
  id: string
  windowId: string
  paneId: string
  source: PreviewSource
  theme: PreviewTheme
  slot: Slot
  guest: PreviewGuest | null
  loaded: number
  served: Set<string>
  watchers: Map<string, FSWatcher>
  reloadTimer: ReturnType<typeof setTimeout> | null
  visible: boolean
  hiddenSince: number | null
  lastShown: number
  waitingSince: number | null
  memoryBytes: number
  busySince: number | null
  gestureAt: number
  frozen: boolean
  stale: boolean
  reported: { responding: boolean; busy: boolean }
}

function notFound(status: number): Response {
  return new Response(null, { status, headers: { 'access-control-allow-origin': '*' } })
}

export class PreviewHost {
  private readonly slots = new Map<string, Slot>()
  private readonly byPane = new Map<string, Slot>()
  private readonly free: Slot[] = []
  private readonly live = new Map<string, Live>()
  private readonly now: () => number
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private metricsTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: PreviewHostDeps) {
    this.now = deps.now ?? Date.now
  }

  open(
    windowId: string,
    paneId: string,
    path: string,
    theme: unknown = null,
  ): PreviewOpened | null {
    if (!this.deps.ownsPane(windowId, paneId) || !isPreviewPath(path)) return null
    const confined = this.deps.confine(path)
    if (!confined) return null
    let file: string
    try {
      file = realpathSync(confined)
    } catch {
      return null
    }
    if (!isPreviewPath(file) || regularFileSize(file) === null) return null
    const folder = dirname(file)
    const slot = this.slotFor(paneId)
    if (slot.live) this.release(slot.live, false)
    const now = this.now()
    const live: Live = {
      id: randomBytes(12).toString('hex'),
      windowId,
      paneId,
      source: { file, root: this.deps.servesFolder(folder) ? folder : null },
      theme: normalizePreviewTheme(theme),
      slot,
      guest: null,
      loaded: 0,
      served: new Set(),
      watchers: new Map(),
      reloadTimer: null,
      visible: true,
      hiddenSince: null,
      lastShown: now,
      waitingSince: null,
      memoryBytes: 0,
      busySince: null,
      gestureAt: 0,
      frozen: false,
      stale: false,
      reported: { responding: true, busy: false },
    }
    slot.live = live
    this.live.set(live.id, live)
    this.enforceCap(windowId)
    this.startTimers()
    return {
      id: live.id,
      partition: slot.partition,
      url: `${PREVIEW_SCHEME}://${live.id}/`,
    }
  }

  private slotFor(paneId: string): Slot {
    const held = this.byPane.get(paneId)
    if (held) return held
    const slot = this.free.pop() ?? this.newSlot()
    this.byPane.set(paneId, slot)
    return slot
  }

  private newSlot(): Slot {
    const nonce = randomBytes(12).toString('hex')
    const partition = previewPartition(nonce)
    const session = this.deps.sessionOf(partition)
    const slot: Slot = { nonce, partition, session, live: null }
    this.slots.set(partition, slot)
    session.protocol.handle(PREVIEW_SCHEME, (request) => this.serve(slot, request))
    session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = allowsPreviewRequest(details.url)
      if (!allowed) this.blocked(slot, details.url)
      callback({ cancel: !allowed })
    })
    void session.setProxy(DEAD_PROXY).catch(() => {})
    session.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(this.allowsPermission(slot, permission)),
    )
    session.setPermissionCheckHandler((_wc, permission) => this.allowsPermission(slot, permission))
    session.on('will-download', (event) => event.preventDefault())
    return slot
  }

  private allowsPermission(slot: Slot, permission: string): boolean {
    const live = slot.live
    if (!live || permission !== CLIPBOARD_WRITE) return false
    return this.now() - live.gestureAt <= GESTURE_MS
  }

  acceptsAttach(partition: string | undefined, src: string | undefined, windowId: string): boolean {
    const live = partition ? this.slots.get(partition)?.live : null
    return Boolean(live && live.windowId === windowId && src === `${PREVIEW_SCHEME}://${live.id}/`)
  }

  adopt(guest: PreviewGuest): boolean {
    const slot = [...this.slots.values()].find((s) => s.session === guest.session)
    if (!slot) return false
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    guest.setBackgroundThrottling(true)
    const live = slot.live
    if (!live || live.guest) {
      guest.forcefullyCrashRenderer()
      return true
    }
    live.guest = guest
    const current = (): Live | null => (slot.live === live && live.guest === guest ? live : null)
    guest.on('will-navigate', (event: { preventDefault: () => void }, url: string) => {
      event.preventDefault()
      if (!current() || typeof url !== 'string' || allowsPreviewRequest(url)) return
      if (this.now() - live.gestureAt > GESTURE_MS) return
      this.deps.send(live.windowId, { id: live.id, type: 'link', url: url.slice(0, MESSAGE_MAX) })
    })
    guest.on('will-redirect', (event: { preventDefault: () => void }) => event.preventDefault())
    guest.on(
      'console-message',
      (event: { level?: string; message?: string; lineNumber?: number; sourceId?: string }) => {
        if (!current() || event.level !== 'error') return
        const message = String(event.message ?? '')
        const host = blockedByPolicy(message)
        if (host) {
          this.report(live, { kind: 'blocked', message: host })
          return
        }
        this.report(live, {
          kind: 'error',
          message: message.slice(0, MESSAGE_MAX),
          ...(event.lineNumber ? { line: event.lineNumber } : {}),
          ...(event.sourceId ? { source: this.shownSource(live, event.sourceId) } : {}),
        })
      },
    )
    guest.on('input-event', (_event: unknown, input: { type?: string }) => {
      if (input?.type && GESTURE_INPUTS.has(input.type)) live.gestureAt = this.now()
    })
    guest.on('unresponsive', () => {
      if (current() && live.waitingSince === null) live.waitingSince = this.now()
    })
    guest.on('render-process-gone', () => {
      if (current()) this.stop(live, 'crashed')
    })
    guest.on('destroyed', () => {
      if (live.guest === guest) live.guest = null
    })
    return true
  }

  private shownSource(live: Live, sourceId: string): string {
    const prefix = `${PREVIEW_SCHEME}://${live.id}/`
    if (!sourceId.startsWith(prefix)) return sourceId.slice(0, 200)
    const rest = sourceId.slice(prefix.length)
    return rest === '' || `/${rest}` === ENTRY_MODULE_PATH ? basename(live.source.file) : rest
  }

  private report(live: Live, error: PreviewError): void {
    this.deps.send(live.windowId, { id: live.id, type: 'error', error })
  }

  private blocked(slot: Slot, url: string): void {
    if (slot.live) this.report(slot.live, { kind: 'blocked', message: blockedHost(url) })
  }

  private async serve(slot: Slot, request: Request): Promise<Response> {
    const live = slot.live
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return notFound(400)
    }
    if (!live || url.host !== live.id) return notFound(404)
    if (request.method !== 'GET' && request.method !== 'HEAD') return notFound(405)
    const send = (body: Buffer | string, headers: Record<string, string>): Response =>
      new Response(request.method === 'HEAD' ? null : new Uint8Array(Buffer.from(body)), {
        status: 200,
        headers,
      })
    const path = url.pathname
    if (path.startsWith(RUNTIME_PREFIX)) {
      const library = await this.runtimeFile(path.slice(RUNTIME_PREFIX.length))
      return library ? send(library, typedHeaders(SCRIPT_TYPE)) : notFound(404)
    }
    const component = isComponentPath(live.source.file)
    const main = path === '/' || path === ''
    if (main) {
      live.loaded = 0
      this.deps.send(live.windowId, { id: live.id, type: 'loading' })
    }
    if (component && main) {
      const nonce = randomBytes(16).toString('base64')
      return send(shellPage(nonce, live.theme), {
        ...typedHeaders(PAGE_TYPE),
        'content-security-policy': shellCsp(nonce),
      })
    }
    if (component && path === SHELL_MODULE_PATH)
      return send(shellModule(), typedHeaders(SCRIPT_TYPE))
    const found = await this.read(live, component && path === ENTRY_MODULE_PATH ? '/' : path)
    if (!found.ok) return notFound(found.status)
    live.loaded += found.body.length
    this.follow(live, found.path)
    if (!compiles(found.path)) return send(found.body, previewHeaders(found.path))
    const label = live.source.root ? relative(live.source.root, found.path) : basename(found.path)
    return send(await this.deps.compile(label, found.body), typedHeaders(SCRIPT_TYPE))
  }

  private async read(live: Live, pathname: string): Promise<PreviewRead> {
    const left = PREVIEW_LIMITS.loadBytes - live.loaded
    const exact = await readPreviewFile(live.source, pathname, left)
    if (exact.ok || exact.status !== 404 || extname(pathname) !== '') return exact
    for (const extension of MODULE_EXTENSIONS) {
      const guess = await readPreviewFile(live.source, `${pathname}${extension}`, left)
      if (guess.ok || guess.status !== 404) return guess
    }
    return exact
  }

  private async runtimeFile(name: string): Promise<Buffer | null> {
    if (!runtimeFiles().includes(name)) return null
    return readFile(join(this.deps.runtimeDir(), name)).catch(() => null)
  }

  private follow(live: Live, path: string): void {
    live.served.add(path)
    const dir = dirname(path)
    if (live.watchers.has(dir) || live.watchers.size >= WATCHED_DIRS_MAX) return
    try {
      const watcher = watch(dir, (_kind, name) => {
        if (name && live.served.has(join(dir, name))) this.scheduleReload(live)
      })
      watcher.on('error', () => {})
      live.watchers.set(dir, watcher)
    } catch {}
  }

  private scheduleReload(live: Live): void {
    if (live.reloadTimer) clearTimeout(live.reloadTimer)
    live.reloadTimer = setTimeout(() => {
      live.reloadTimer = null
      if (live.frozen) live.stale = true
      else this.reload(live)
    }, PREVIEW_LIMITS.reloadDebounceMs)
  }

  private reload(live: Live): void {
    if (live.slot.live !== live || !live.guest || live.guest.isDestroyed()) return
    live.stale = false
    live.served.clear()
    live.guest.reload()
  }

  private pauseScripts(live: Live, paused: boolean): Promise<boolean> {
    const guest = live.guest
    if (!guest || guest.isDestroyed()) return Promise.resolve(false)
    try {
      if (!guest.debugger.isAttached()) guest.debugger.attach(DEBUGGER_PROTOCOL)
    } catch {
      return Promise.resolve(false)
    }
    return guest.debugger.sendCommand(PAUSE_SCRIPTS, { value: paused }).then(
      () => true,
      () => false,
    )
  }

  private freeze(live: Live): void {
    if (live.frozen || live.visible) return
    live.frozen = true
    void this.pauseScripts(live, true).then((done) => {
      if (!done) live.frozen = false
      else if (live.visible) this.thaw(live)
    })
  }

  private thaw(live: Live): void {
    if (!live.frozen) return
    void this.pauseScripts(live, false).then(() => {
      live.frozen = false
      if (live.stale) this.reload(live)
    })
  }

  shown(windowId: string, id: string, visible: boolean): void {
    const live = this.live.get(id)
    if (!live || live.windowId !== windowId || live.visible === visible) return
    const now = this.now()
    live.visible = visible
    live.hiddenSince = visible ? null : now
    if (!visible) {
      live.busySince = null
      return
    }
    live.lastShown = now
    this.thaw(live)
  }

  stopByHuman(windowId: string, id: string): void {
    const live = this.live.get(id)
    if (live && live.windowId === windowId) this.stop(live, 'human')
  }

  close(windowId: string, id: string): void {
    const live = this.live.get(id)
    if (live && live.windowId === windowId) this.release(live, false)
  }

  paneClosed(paneId: string): void {
    const slot = this.byPane.get(paneId)
    if (!slot) return
    if (slot.live) this.release(slot.live, false)
    this.byPane.delete(paneId)
    void slot.session.clearStorageData().catch(() => {})
    this.free.push(slot)
  }

  windowClosed(windowId: string): void {
    for (const live of [...this.live.values()]) {
      if (live.windowId === windowId) this.paneClosed(live.paneId)
    }
  }

  private stop(live: Live, reason: PreviewStopReason): void {
    if (this.live.get(live.id) !== live) return
    this.deps.send(live.windowId, { id: live.id, type: 'stopped', reason })
    this.release(live, true)
  }

  private release(live: Live, kill: boolean): void {
    this.live.delete(live.id)
    if (live.slot.live === live) live.slot.live = null
    if (live.reloadTimer) clearTimeout(live.reloadTimer)
    for (const watcher of live.watchers.values()) watcher.close()
    live.watchers.clear()
    const guest = live.guest
    live.guest = null
    if (kill && guest && !guest.isDestroyed()) {
      try {
        guest.forcefullyCrashRenderer()
      } catch {}
    }
    if (this.live.size === 0) this.stopTimers()
  }

  private enforceCap(windowId: string): void {
    const inWindow = [...this.live.values()].filter((live) => live.windowId === windowId)
    for (const id of previewsOverCap(inWindow)) {
      const live = this.live.get(id)
      if (live) this.stop(live, 'limit')
    }
  }

  tick(): void {
    const now = this.now()
    for (const live of [...this.live.values()]) {
      this.ping(live, now)
      const verdict = previewVerdict(live, now)
      if (verdict.stop) {
        this.stop(live, verdict.stop)
        continue
      }
      const { responding, busy } = verdict
      if (responding === live.reported.responding && busy === live.reported.busy) continue
      live.reported = { responding, busy }
      this.deps.send(live.windowId, { id: live.id, type: 'vitals', responding, busy })
    }
  }

  private ping(live: Live, now: number): void {
    const guest = live.guest
    if (!guest || guest.isDestroyed() || live.frozen || live.waitingSince !== null) return
    live.waitingSince = now
    const answered = (): void => {
      if (live.guest !== guest) return
      live.waitingSince = null
      this.freeze(live)
    }
    guest.executeJavaScript('0').then(answered, answered)
  }

  measure(): void {
    const now = this.now()
    const byPid = new Map(this.deps.processes().map((use) => [use.pid, use]))
    for (const live of this.live.values()) {
      const guest = live.guest
      const use = guest && !guest.isDestroyed() ? byPid.get(guest.getOSProcessId()) : undefined
      live.memoryBytes = use?.memoryBytes ?? 0
      live.busySince = busySince(live.busySince, use?.cpuPercent ?? 0, live.visible, now)
    }
  }

  private startTimers(): void {
    this.pingTimer ??= setInterval(() => this.tick(), PING_MS)
    this.metricsTimer ??= setInterval(() => this.measure(), METRICS_MS)
  }

  private stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.metricsTimer) clearInterval(this.metricsTimer)
    this.pingTimer = null
    this.metricsTimer = null
  }

  dispose(): void {
    for (const live of [...this.live.values()]) this.release(live, true)
    this.stopTimers()
  }
}

const HOST_SET_ATTRIBUTES = [
  'preload',
  'allowpopups',
  'nodeintegration',
  'nodeintegrationinsubframes',
  'plugins',
  'disablewebsecurity',
  'webpreferences',
  'blinkfeatures',
  'disableblinkfeatures',
  'enableblinkfeatures',
  'useragent',
  'httpreferrer',
]

export function hardenPreviewAttach(
  webPreferences: Electron.WebPreferences,
  params: Record<string, string>,
): void {
  webPreferences.preload = undefined
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.nodeIntegrationInWorker = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.webSecurity = true
  webPreferences.webviewTag = false
  webPreferences.disableDialogs = true
  webPreferences.navigateOnDragDrop = false
  webPreferences.autoplayPolicy = 'user-gesture-required'
  webPreferences.transparent = false
  webPreferences.experimentalFeatures = false
  webPreferences.plugins = false
  webPreferences.allowRunningInsecureContent = false
  webPreferences.enableBlinkFeatures = undefined
  webPreferences.disableBlinkFeatures = undefined
  for (const name of HOST_SET_ATTRIBUTES) {
    delete params[name]
  }
}

export function registerPreviewIpc(host: PreviewHost): void {
  ipcMain.handle(
    'preview:open',
    (e, paneId: unknown, path: unknown, theme: unknown): PreviewOpened | null =>
      typeof paneId === 'string' && typeof path === 'string'
        ? host.open(String(e.sender.id), paneId, path, theme)
        : null,
  )
  ipcMain.on('preview:shown', (e, id: unknown, visible: unknown) => {
    if (typeof id === 'string') host.shown(String(e.sender.id), id, visible === true)
  })
  ipcMain.on('preview:stop', (e, id: unknown) => {
    if (typeof id === 'string') host.stopByHuman(String(e.sender.id), id)
  })
  ipcMain.on('preview:close', (e, id: unknown) => {
    if (typeof id === 'string') host.close(String(e.sender.id), id)
  })
}
