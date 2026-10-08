import { randomBytes } from 'node:crypto'
import {
  constants,
  type FSWatcher,
  type Stats,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  watch,
} from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { ipcMain } from 'electron'
import {
  PREVIEW_LIMITS,
  PREVIEW_PAGE_CSP,
  PREVIEW_SCHEME,
  type PreviewError,
  type PreviewEvent,
  type PreviewOpened,
  type PreviewStopReason,
  allowsPreviewRequest,
  blockedByPolicy,
  blockedHost,
  isPreviewPath,
  previewPartition,
} from '../shared/htmlPreview'
import { isHiddenFromPhone } from './gateway/workspaceFiles'
import { busySince, previewVerdict, previewsOverCap } from './previewLimits'

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
  return {
    'content-type': previewMime(path),
    'content-security-policy': PREVIEW_PAGE_CSP,
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
}

export interface PreviewSource {
  file: string
  root: string | null
}

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

function stillAt(path: string, opened: Stats): boolean {
  try {
    return realpathSync(path) === path && sameFile(statSync(path), opened)
  } catch {
    return false
  }
}

export function readPreviewFile(
  source: PreviewSource,
  pathname: string,
  maxBytes: number,
): PreviewRead {
  const found = resolvePreviewFile(source, pathname)
  if (!found.ok) return found
  let fd: number
  try {
    fd = openSync(found.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return { ok: false, status: 404 }
  }
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || !stillAt(found.path, opened)) return { ok: false, status: 404 }
    if (opened.size > maxBytes) return { ok: false, status: 413 }
    const body = Buffer.alloc(opened.size)
    let read = 0
    while (read < body.length) {
      const got = readSync(fd, body, read, body.length - read, read)
      if (got === 0) break
      read += got
    }
    return { ok: true, path: found.path, body: body.subarray(0, read) }
  } catch {
    return { ok: false, status: 404 }
  } finally {
    closeSync(fd)
  }
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
  insideRoots: (dir: string) => boolean
  ownsPane: (windowId: string, paneId: string) => boolean
  send: (windowId: string, event: PreviewEvent) => void
  processes: () => ProcessUse[]
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

  open(windowId: string, paneId: string, path: string): PreviewOpened | null {
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
      source: { file, root: this.deps.insideRoots(folder) ? folder : null },
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
    session.protocol.handle(PREVIEW_SCHEME, async (request) => this.serve(slot, request))
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
    return rest === '' ? basename(live.source.file) : rest
  }

  private report(live: Live, error: PreviewError): void {
    this.deps.send(live.windowId, { id: live.id, type: 'error', error })
  }

  private blocked(slot: Slot, url: string): void {
    if (slot.live) this.report(slot.live, { kind: 'blocked', message: blockedHost(url) })
  }

  private serve(slot: Slot, request: Request): Response {
    const live = slot.live
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return notFound(400)
    }
    if (!live || url.host !== live.id) return notFound(404)
    if (request.method !== 'GET' && request.method !== 'HEAD') return notFound(405)
    const main = url.pathname === '/' || url.pathname === ''
    if (main) {
      live.loaded = 0
      this.deps.send(live.windowId, { id: live.id, type: 'loading' })
    }
    const found = readPreviewFile(live.source, url.pathname, PREVIEW_LIMITS.loadBytes - live.loaded)
    if (!found.ok) return notFound(found.status)
    live.loaded += found.body.length
    this.follow(live, found.path)
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(found.body), {
      status: 200,
      headers: previewHeaders(found.path),
    })
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
  for (const name of ['preload', 'allowpopups', 'nodeintegration', 'webpreferences']) {
    delete params[name]
  }
}

export function registerPreviewIpc(host: PreviewHost): void {
  ipcMain.handle('preview:open', (e, paneId: unknown, path: unknown): PreviewOpened | null =>
    typeof paneId === 'string' && typeof path === 'string'
      ? host.open(String(e.sender.id), paneId, path)
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
