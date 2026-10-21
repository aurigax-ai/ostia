import { randomBytes } from 'node:crypto'
import { type FSWatcher, realpathSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  allowsPreviewRequest,
  blockedByPolicy,
  blockedHost,
  isPreviewPath,
  normalizePreviewTheme,
  PREVIEW_LIMITS,
  PREVIEW_SCHEME,
  type PreviewError,
  type PreviewOpened,
  type PreviewStopReason,
  type PreviewTheme,
  previewPartition,
} from '../../shared/artifacts/htmlPreview'
import {
  REGION_IMAGE_MAX,
  regionCaptureRect,
  regionPageRect,
} from '../../shared/browser/regionCapture'
import { lockDownSession, previewHeaders } from './previewAttach'
import { type PreviewSource, regularFileSize } from './previewFiles'
import type { PreviewGuest, PreviewHostDeps, PreviewRect, PreviewSession } from './previewHostTypes'
import { busySince, previewsOverCap, previewVerdict } from './previewLimits'

const PING_MS = 1_000
const METRICS_MS = 5_000
const GESTURE_MS = 5_000
const MESSAGE_MAX = 2_000
const WATCHED_DIRS_MAX = 16
const GESTURE_INPUTS = new Set(['mouseDown', 'keyDown', 'touchStart'])
const CLIPBOARD_WRITE = 'clipboard-sanitized-write'
const DEBUGGER_PROTOCOL = '1.3'
const PAUSE_SCRIPTS = 'Emulation.setScriptExecutionDisabled'

const REGION_MIN = 4

function regionOf(value: unknown): PreviewRect | null {
  const raw = value as Partial<PreviewRect> | null
  if (!raw || typeof raw !== 'object') return null
  const [x, y, width, height] = [raw.x, raw.y, raw.width, raw.height].map((n) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : Number.NaN,
  )
  if ([x, y, width, height].some(Number.isNaN) || x < 0 || y < 0) return null
  if (width < REGION_MIN || height < REGION_MIN) return null
  return { x, y, width, height }
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
  return new Response(null, { status })
}

export class PreviewHost {
  private readonly slots = new Map<string, Slot>()
  private readonly byPane = new Map<string, Slot>()
  private readonly free: Slot[] = []
  private readonly live = new Map<string, Live>()
  private readonly themes = new Map<string, PreviewTheme>()
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
      theme: this.rememberTheme(windowId, theme),
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

  private rememberTheme(windowId: string, theme: unknown): PreviewTheme {
    const normal = normalizePreviewTheme(theme)
    this.themes.set(windowId, normal)
    return normal
  }

  themeOf(windowId: string | undefined): PreviewTheme {
    return (windowId ? this.themes.get(windowId) : undefined) ?? normalizePreviewTheme(null)
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
    lockDownSession(session, (permission) => this.allowsPermission(slot, permission))
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
    return sourceId.startsWith(`${PREVIEW_SCHEME}://${live.id}/`)
      ? (live.source.file.split('/').pop() ?? sourceId)
      : sourceId.slice(0, 200)
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
    if (url.pathname !== '/' && url.pathname !== '') return notFound(404)
    live.loaded = 0
    this.deps.send(live.windowId, { id: live.id, type: 'loading' })
    const built = await this.deps.build(live.source, live.theme)
    if (slot.live !== live) return notFound(404)
    live.served.clear()
    for (const input of built.inputs) this.follow(live, input)
    const body = Buffer.from(built.document)
    live.loaded = body.length
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), {
      status: 200,
      headers: previewHeaders(live.source.file),
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

  async capture(windowId: string, id: string, rect: unknown): Promise<Uint8Array | null> {
    const live = this.live.get(id)
    const region = regionOf(rect)
    if (!live || live.windowId !== windowId || !region) return null
    const guest = live.guest
    if (!guest || guest.isDestroyed()) return null
    const zoom = this.deps.hostZoom?.(windowId) ?? 1
    try {
      const image = await guest.capturePage(regionCaptureRect(region, zoom))
      if (image.isEmpty()) return null
      const png = image.toPNG()
      return png.byteLength > REGION_IMAGE_MAX ? null : new Uint8Array(png)
    } catch {
      return null
    }
  }

  pageRegion(windowId: string, rect: unknown): PreviewRect | null {
    const region = regionOf(rect)
    return region ? regionPageRect(region, this.deps.hostZoom?.(windowId) ?? 1, 1) : null
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
