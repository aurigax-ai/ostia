import { randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  PORTABLE_TABLE_COLUMNS_MAX,
  PORTABLE_TABLE_ROWS_MAX,
  PORTABLE_TABLES_BYTES_MAX,
  PORTABLE_TABLES_MAX,
  type PortableTable,
  VIEWER_CHANGED_EVENT,
  VIEWER_DOCUMENT_PATH,
  VIEWER_EVENTS_PATH,
  VIEWER_META_PATH,
  VIEWER_PORTABLE_PATH,
  VIEWER_SCHEME,
  VIEWER_SELECTION_CLEARED_EVENT,
  type ViewerDocumentMeta,
  type ViewerPortableTables,
} from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import {
  VIEWER_EDIT_SOURCE_PATH,
  VIEWER_FIND_KEYS_PATH,
  VIEWER_OPEN_HREF_MAX,
  VIEWER_OPEN_PATH,
  VIEWER_SELECTION_BODY_MAX,
  VIEWER_SELECTION_PATH,
} from '@aurigax-ai/ostia-extension-sdk/contract/viewerSelection'
import type { SelectionCapture } from '../../../shared/browser/selection'
import { externalHref } from '../../../shared/common/externalLinks'
import type {
  ViewerDocumentText,
  ViewerEditSource,
  ViewerLinkTarget,
  ViewerOpenLink,
  ViewerOpenRequest,
  ViewerOpenResult,
  ViewerSelectionEvent,
  ViewerStopped,
} from '../../../shared/files/filesApi'
import type { ClipboardCapture } from '../../../shared/keyboard/clipboardCapture'
import type { FsRangeResult } from '../fsRange'
import { readBoundedBody } from './viewerBody'
import { clipboardOf, copyStatus, type ViewerCopyStrings } from './viewerClipboard'
import { parseByteRange } from './viewerRanges'
import { acceptGuestSelection, type StoredSelection, selectionState } from './viewerSelection'
import {
  contentTypeOf,
  extensionOfViewerPartition,
  hardenViewerSession,
  type ViewerSession,
  viewerAllowsWasm,
  viewerHeaders,
  viewerPartition,
} from './viewerSessions'
import type { ViewerWatch, WatchedGuest } from './viewerWatch'

interface ViewerSource {
  dir: string
  entry: string
}

export type ViewerRead = { ok: true; body: Buffer } | { ok: false; status: number }

interface ViewerStat {
  size: number
  modified: number
}

export type ViewerEvent =
  | { type: 'selection'; payload: ViewerSelectionEvent }
  | { type: 'open-link'; payload: ViewerOpenLink }
  | { type: 'edit-source'; payload: ViewerEditSource }

export interface ViewerGuest extends WatchedGuest {
  session: unknown
  setWindowOpenHandler: (handler: () => { action: 'deny' }) => void
  setWebRTCIPHandlingPolicy: (policy: 'disable_non_proxied_udp') => void
  // biome-ignore lint/suspicious/noExplicitAny: Electron's per-event listener signatures differ.
  on: (event: any, listener: (...args: any[]) => void) => unknown
}

export interface ViewerHostDeps {
  sessionOf: (partition: string) => ViewerSession
  confine: (path: string) => string | null
  ownsPane: (windowId: string, paneId: string) => boolean
  viewer: (extId: string, viewType: string, path: string) => ViewerSource | null
  readDocument: (path: string) => Promise<ViewerRead>
  readRange: (path: string, start: number, end: number) => Promise<FsRangeResult | null>
  statDocument: (path: string) => Promise<ViewerStat | null>
  readExtensionFile: (dir: string, path: string) => Buffer | null
  watch: (owner: string, path: string) => void
  unwatch: (owner: string, path: string) => void
  locale: () => string
  guests: ViewerWatch
  stopped: (windowId: string, event: ViewerStopped) => void
  emit: (windowId: string, event: ViewerEvent) => void
  writeClipboard: (copied: ClipboardCapture) => Promise<void>
  copyStrings: () => ViewerCopyStrings
  fileLinksAllowed: (paneId: string) => boolean
  now?: () => number
  token?: () => string
}

interface Live {
  token: string
  windowId: string
  paneId: string
  extId: string
  viewType: string
  path: string
  source: ViewerSource
  streams: Set<ReadableStreamDefaultController<Uint8Array>>
  portable: ViewerPortableTables | 'too-large' | null
  selection: StoredSelection | null
  selectionSeq: number
  documentText: string | null
  rangeStreams: Set<() => void>
  rangeSlots: number
  pointerAt: number | null
  pointerShift: boolean
  keyAt: number | null
  keyShift: boolean
  ownsFindKeys: boolean
}

export const RANGE_STREAMS_MAX = 8
export const GESTURE_WINDOW_MS = 3000
export const DOCUMENT_TEXT_MAX = 4 * 1024 * 1024

const POINTER_INPUTS = new Set(['mouseDown', 'mouseUp', 'touchStart', 'touchEnd'])
const OWNER_PREFIX = 'viewer:'
const encoder = new TextEncoder()

function isText(value: unknown): value is string {
  return typeof value === 'string'
}

function portableTables(raw: unknown): ViewerPortableTables | null {
  const tables = (raw as { tables?: unknown } | null)?.tables
  if (!Array.isArray(tables) || tables.length > PORTABLE_TABLES_MAX) return null
  const out: PortableTable[] = []
  for (const table of tables) {
    const { name, columns, rows } = (table ?? {}) as Record<string, unknown>
    if (!isText(name) || !Array.isArray(columns) || !Array.isArray(rows)) return null
    if (columns.length > PORTABLE_TABLE_COLUMNS_MAX || rows.length > PORTABLE_TABLE_ROWS_MAX) {
      return null
    }
    if (!columns.every(isText)) return null
    for (const row of rows) {
      if (!Array.isArray(row) || row.length > PORTABLE_TABLE_COLUMNS_MAX || !row.every(isText)) {
        return null
      }
    }
    out.push({ name, columns, rows: rows as string[][] })
  }
  return { tables: out }
}

export function viewerOwner(token: string): string {
  return `${OWNER_PREFIX}${token}`
}

interface NavigationSource {
  on: (
    event: 'did-start-navigation',
    listener: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void,
  ) => unknown
}

export class ViewerHost {
  private readonly byToken = new Map<string, Live>()
  private readonly prepared = new Map<string, ViewerSession>()
  private readonly now: () => number

  constructor(private readonly deps: ViewerHostDeps) {
    this.now = deps.now ?? Date.now
  }

  private newToken(): string {
    return this.deps.token?.() ?? randomBytes(16).toString('hex')
  }

  private sessionFor(extId: string): ViewerSession {
    const partition = viewerPartition(extId)
    const known = this.prepared.get(partition)
    if (known) return known
    const session = this.deps.sessionOf(partition)
    hardenViewerSession(session, (request) => this.serve(extId, request))
    this.prepared.set(partition, session)
    return session
  }

  open(windowId: string, request: ViewerOpenRequest): ViewerOpenResult {
    const { paneId, path, viewType } = request ?? ({} as ViewerOpenRequest)
    if (!isText(paneId) || !isText(path) || !isText(viewType)) return { ok: false, error: 'denied' }
    if (!this.deps.ownsPane(windowId, paneId)) return { ok: false, error: 'denied' }
    const extId = viewType.slice(0, viewType.indexOf('.'))
    const source = extId ? this.deps.viewer(extId, viewType, path) : null
    if (!source) return { ok: false, error: 'unknown-viewer' }
    const confined = this.deps.confine(path)
    if (!confined) return { ok: false, error: 'denied' }
    this.close(windowId, paneId)
    this.sessionFor(extId)
    const token = this.newToken()
    const live: Live = {
      token,
      windowId,
      paneId,
      extId,
      viewType,
      path: confined,
      source,
      streams: new Set(),
      portable: null,
      selection: null,
      selectionSeq: 0,
      documentText: null,
      rangeStreams: new Set(),
      rangeSlots: 0,
      pointerAt: null,
      pointerShift: false,
      keyShift: false,
      ownsFindKeys: false,
      keyAt: null,
    }
    this.byToken.set(token, live)
    this.deps.watch(viewerOwner(token), confined)
    return {
      ok: true,
      src: `${VIEWER_SCHEME}://${token}/${source.entry}`,
      partition: viewerPartition(extId),
    }
  }

  close(windowId: string, paneId: string): void {
    for (const live of [...this.byToken.values()]) {
      if (live.windowId === windowId && live.paneId === paneId) this.end(live)
    }
  }

  followReloads(contents: NavigationSource, windowId: string): void {
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.forgetWindow(windowId)
    })
  }

  forgetWindow(windowId: string): void {
    for (const live of [...this.byToken.values()]) {
      if (live.windowId === windowId) this.end(live)
    }
  }

  private end(live: Live): void {
    this.byToken.delete(live.token)
    this.deps.guests.unwatch(live.token)
    this.deps.unwatch(viewerOwner(live.token), live.path)
    for (const stream of live.streams) {
      try {
        stream.close()
      } catch {}
    }
    live.streams.clear()
    for (const finish of [...live.rangeStreams]) finish()
    this.forgetSelection(live)
  }

  private forgetSelection(live: Live): boolean {
    if (!live.selection) return false
    live.selection = null
    this.pushSelection(live)
    return true
  }

  changed(owner: string): void {
    if (!owner.startsWith(OWNER_PREFIX)) return
    const live = this.byToken.get(owner.slice(OWNER_PREFIX.length))
    if (!live) return
    this.forgetSelection(live)
    this.announceChange(live)
  }

  private announceChange(live: Live): void {
    this.announce(live, VIEWER_CHANGED_EVENT)
  }

  private announce(live: Live, event: string): void {
    const message = encoder.encode(`event: ${event}\ndata: 1\n\n`)
    for (const stream of live.streams) {
      try {
        stream.enqueue(message)
      } catch {
        live.streams.delete(stream)
      }
    }
  }

  portable(windowId: string, path: string): ViewerPortableTables | 'too-large' | null {
    const confined = this.deps.confine(path)
    if (!confined) return null
    for (const live of this.byToken.values()) {
      if (live.windowId === windowId && live.path === confined && live.portable)
        return live.portable
    }
    return null
  }

  private liveOfPane(windowId: string, paneId: unknown): Live | null {
    if (typeof paneId !== 'string') return null
    for (const live of this.byToken.values()) {
      if (live.windowId === windowId && live.paneId === paneId) return live
    }
    return null
  }

  private pushSelection(live: Live): void {
    this.deps.emit(live.windowId, {
      type: 'selection',
      payload: {
        paneId: live.paneId,
        selection: live.selection ? selectionState(live.selection) : null,
      },
    })
  }

  private async copyStored(stored: StoredSelection): Promise<string> {
    const copied = clipboardOf(stored)
    const strings = this.deps.copyStrings()
    if (copied.text === undefined && copied.html === undefined && !copied.png) {
      return strings.nothing
    }
    await this.deps.writeClipboard(copied)
    return copyStatus(copied, strings, stored.capture)
  }

  async copySelection(windowId: string, paneId: unknown): Promise<string> {
    const stored = this.liveOfPane(windowId, paneId)?.selection
    return stored ? this.copyStored(stored) : this.deps.copyStrings().nothing
  }

  ownsFindKeys(guest: { getURL: () => string }): boolean {
    return this.liveOf(guest.getURL())?.ownsFindKeys === true
  }

  copyForGuest(guest: { getURL: () => string }): boolean {
    const stored = this.liveOf(guest.getURL())?.selection
    if (!stored) return false
    void this.copyStored(stored).catch(() => undefined)
    return true
  }

  selectionForSend(
    windowId: string,
    paneId: unknown,
  ): { capture: SelectionCapture; image: Uint8Array | null } | null {
    const stored = this.liveOfPane(windowId, paneId)?.selection
    return stored ? { capture: stored.capture, image: stored.png } : null
  }

  setDocumentText(windowId: string, request: unknown): void {
    const { paneId, path, text } = (request ?? {}) as Partial<ViewerDocumentText>
    const live = this.liveOfPane(windowId, paneId)
    if (!live || typeof path !== 'string' || this.deps.confine(path) !== live.path) return
    if (text !== null && typeof text !== 'string') return
    const tooLarge =
      text !== null &&
      (text.length > DOCUMENT_TEXT_MAX || Buffer.byteLength(text) > DOCUMENT_TEXT_MAX)
    const next = tooLarge ? null : text
    if (live.documentText === next) return
    live.documentText = next
    this.announceChange(live)
  }

  acceptsAttach(partition: string | undefined, src: string | undefined, windowId: string): boolean {
    const extId = extensionOfViewerPartition(partition)
    if (!extId || !src) return false
    const live = this.liveOf(src)
    return Boolean(
      live &&
        live.extId === extId &&
        live.windowId === windowId &&
        src.split('#', 1)[0] === `${VIEWER_SCHEME}://${live.token}/${live.source.entry}`,
    )
  }

  adopt(guest: ViewerGuest): boolean {
    if (![...this.prepared.values()].includes(guest.session as ViewerSession)) return false
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    let shownUrl: string | null = null
    guest.on('will-navigate', (event: { url?: string; preventDefault: () => void }) => {
      if (event.url === undefined || event.url !== shownUrl) event.preventDefault()
    })
    guest.on('did-navigate-in-page', (_event: unknown, url: string, isMainFrame: boolean) => {
      if (isMainFrame) shownUrl = url
    })
    guest.on('will-redirect', (event: { preventDefault: () => void }) => event.preventDefault())
    let token: string | null = null
    guest.on('did-navigate', (_event: unknown, url: string) => {
      shownUrl = url
      const live = typeof url === 'string' ? this.liveOf(url) : null
      if (token) this.deps.guests.unwatch(token)
      token = live?.token ?? null
      if (live) {
        this.forgetSelection(live)
        live.ownsFindKeys = false
        this.watchGuest(live, guest)
      }
    })
    guest.on(
      'input-event',
      (_event: unknown, input: { type?: string; modifiers?: string[] } | undefined) => {
        const live = token ? this.byToken.get(token) : undefined
        if (live && input?.type && POINTER_INPUTS.has(input.type)) {
          live.pointerAt = this.now()
          live.pointerShift = input.modifiers?.includes('shift') === true
        }
      },
    )
    guest.on(
      'before-input-event',
      (_event: unknown, input: { type?: string; shift?: boolean } | undefined) => {
        const live = token ? this.byToken.get(token) : undefined
        if (live && input?.type === 'keyDown') {
          live.keyAt = this.now()
          live.keyShift = input.shift === true
        }
      },
    )
    guest.on('unresponsive', () => {
      if (token) this.deps.guests.unresponsive(token)
    })
    guest.on('render-process-gone', () => {
      if (token) this.deps.guests.unwatch(token)
    })
    return true
  }

  private watchGuest(live: Live, guest: ViewerGuest): void {
    this.deps.guests.watch(live.token, guest, (reason) => {
      if (this.byToken.get(live.token) !== live) return
      this.deps.stopped(live.windowId, { paneId: live.paneId, reason })
      this.end(live)
    })
  }

  private liveOf(url: string): Live | null {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== `${VIEWER_SCHEME}:`) return null
      return this.byToken.get(parsed.hostname) ?? null
    } catch {
      return null
    }
  }

  async serve(extId: string, request: Request): Promise<Response> {
    const live = this.liveOf(request.url)
    if (!live || live.extId !== extId) return new Response(null, { status: 404 })
    if (!this.deps.viewer(live.extId, live.viewType, live.path)) {
      return new Response(null, { status: 410 })
    }
    const { pathname } = new URL(request.url)
    if (pathname === VIEWER_PORTABLE_PATH && request.method === 'POST') {
      return this.receivePortable(live, request)
    }
    if (pathname === VIEWER_SELECTION_PATH && request.method === 'POST') {
      return this.receiveSelection(live, request)
    }
    if (pathname === VIEWER_SELECTION_PATH && request.method === 'DELETE') {
      return this.dropSelection(live)
    }
    if (pathname === VIEWER_OPEN_PATH && request.method === 'POST') {
      return this.receiveOpen(live, request)
    }
    if (pathname === VIEWER_EDIT_SOURCE_PATH && request.method === 'POST') {
      return this.receiveEditSource(live)
    }
    if (pathname === VIEWER_FIND_KEYS_PATH && request.method === 'POST') {
      live.ownsFindKeys = true
      return new Response(null, { status: 204 })
    }
    if (request.method !== 'GET') return new Response(null, { status: 405 })
    if (pathname === VIEWER_META_PATH) return this.meta(live)
    if (pathname === VIEWER_DOCUMENT_PATH) return this.document(live, request)
    if (pathname === VIEWER_EVENTS_PATH) return this.events(live)
    return this.extensionFile(live, pathname)
  }

  private headers(live: Live, contentType: string, extra: Record<string, string> = {}): Headers {
    return viewerHeaders(contentType, extra, viewerAllowsWasm(live.extId))
  }

  private async meta(live: Live): Promise<Response> {
    const stat = await this.deps.statDocument(live.path)
    if (!stat) return new Response(null, { status: 404, headers: this.headers(live, 'text/plain') })
    const meta: ViewerDocumentMeta = {
      name: live.path.slice(live.path.lastIndexOf('/') + 1),
      size: live.documentText === null ? stat.size : Buffer.byteLength(live.documentText),
      modified: stat.modified,
      locale: this.deps.locale(),
      viewType: live.viewType,
    }
    return new Response(JSON.stringify(meta), {
      headers: this.headers(live, 'application/json; charset=utf-8'),
    })
  }

  private async document(live: Live, request: Request): Promise<Response> {
    if (live.documentText !== null) {
      return new Response(Buffer.from(live.documentText), {
        headers: this.headers(live, 'application/octet-stream', { 'accept-ranges': 'none' }),
      })
    }
    const range = request.headers.get('range')
    if (range !== null) {
      const ranged = await this.rangedDocument(live, range)
      if (ranged) return ranged
    }
    const read = await this.deps.readDocument(live.path)
    if (read.ok) {
      return new Response(new Uint8Array(read.body), {
        headers: this.headers(live, 'application/octet-stream', { 'accept-ranges': 'bytes' }),
      })
    }
    const size = (await this.deps.statDocument(live.path))?.size
    return new Response(null, {
      status: read.status,
      headers: this.headers(live, 'text/plain', size ? { 'x-ostia-size': String(size) } : {}),
    })
  }

  private async rangedDocument(live: Live, header: string): Promise<Response | null> {
    const stat = await this.deps.statDocument(live.path)
    if (!stat) return new Response(null, { status: 404, headers: this.headers(live, 'text/plain') })
    const range = parseByteRange(header, stat.size)
    if (range.kind === 'none') return null
    const unsatisfiable = (): Response =>
      new Response(null, {
        status: 416,
        headers: this.headers(live, 'text/plain', { 'content-range': `bytes */${stat.size}` }),
      })
    if (range.kind === 'unsatisfiable') return unsatisfiable()
    if (live.rangeSlots >= RANGE_STREAMS_MAX) {
      return new Response(null, { status: 429, headers: this.headers(live, 'text/plain') })
    }
    live.rangeSlots++
    const release = (): void => {
      live.rangeSlots--
    }
    let opened: FsRangeResult | null
    try {
      opened = await this.deps.readRange(live.path, range.start, range.end)
    } catch {
      opened = { ok: false, error: 'unreadable' }
    }
    if (opened === null) {
      release()
      return null
    }
    if (!opened.ok) {
      release()
      if (opened.error === 'unsatisfiable') return unsatisfiable()
      return new Response(null, { status: 410, headers: this.headers(live, 'text/plain') })
    }
    const { reader } = opened
    if (this.byToken.get(live.token) !== live) {
      release()
      await reader.close()
      return new Response(null, { status: 404, headers: this.headers(live, 'text/plain') })
    }
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      live.rangeStreams.delete(finish)
      release()
      void reader.close()
    }
    live.rangeStreams.add(finish)
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const chunk = await reader.read()
          if (chunk) {
            controller.enqueue(chunk)
            return
          }
          finish()
          controller.close()
        } catch (error) {
          finish()
          controller.error(error)
        }
      },
      cancel: finish,
    })
    return new Response(body, {
      status: 206,
      headers: this.headers(live, 'application/octet-stream', {
        'accept-ranges': 'bytes',
        'content-range': `bytes ${range.start}-${range.end}/${reader.size}`,
        'content-length': String(range.end - range.start + 1),
      }),
    })
  }

  private events(live: Live): Response {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c
        live.streams.add(c)
        c.enqueue(encoder.encode(': open\n\n'))
      },
      cancel: () => {
        if (controller) live.streams.delete(controller)
      },
    })
    return new Response(stream, { headers: this.headers(live, 'text/event-stream') })
  }

  private async receivePortable(live: Live, request: Request): Promise<Response> {
    const body = await readBoundedBody(request, PORTABLE_TABLES_BYTES_MAX)
    if (!body) {
      live.portable = 'too-large'
      return new Response(null, { status: 413 })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {
      return new Response(null, { status: 400 })
    }
    const tables = portableTables(parsed)
    if (!tables) return new Response(null, { status: 400 })
    live.portable = tables
    return new Response(null, { status: 204 })
  }

  private async receiveSelection(live: Live, request: Request): Promise<Response> {
    if (!this.recentInput(live)) return new Response(null, { status: 403 })
    const body = await readBoundedBody(request, VIEWER_SELECTION_BODY_MAX)
    if (!body) return new Response(null, { status: 413 })
    const stored = acceptGuestSelection(body, live.path, live.selectionSeq + 1)
    if (!stored) return new Response(null, { status: 400 })
    live.selectionSeq = stored.seq
    live.selection = stored
    this.pushSelection(live)
    return new Response(null, { status: 204 })
  }

  clearSelection(windowId: string, paneId: unknown): void {
    const live = this.liveOfPane(windowId, paneId)
    if (live && this.forgetSelection(live)) this.announce(live, VIEWER_SELECTION_CLEARED_EVENT)
  }

  private dropSelection(live: Live): Response {
    this.forgetSelection(live)
    return new Response(null, { status: 204 })
  }

  private recentInput(live: Live): boolean {
    const now = this.now()
    return [live.pointerAt, live.keyAt].some((at) => at !== null && now - at <= GESTURE_WINDOW_MS)
  }

  private spendGesture(live: Live): 'pointerAt' | 'keyAt' | null {
    const now = this.now()
    const fresh = (['pointerAt', 'keyAt'] as const)
      .filter((input) => {
        const at = live[input]
        return at !== null && now - at <= GESTURE_WINDOW_MS
      })
      .sort((a, b) => (live[b] ?? 0) - (live[a] ?? 0))
    live.pointerAt = null
    live.keyAt = null
    return fresh[0] ?? null
  }

  private linkTarget(live: Live, href: string, shift: boolean): ViewerLinkTarget | null {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      const external = externalHref(href, { apps: false })
      return external ? { kind: 'url', href: external, shift } : null
    }
    if (href.startsWith('//') || href.includes('\\')) return null
    let relative: string
    try {
      relative = decodeURIComponent(href.replace(/[?#].*$/, ''))
    } catch {
      return null
    }
    if (relative === '' || isAbsolute(relative)) return null
    if (!isAbsolute(live.path) || !this.deps.fileLinksAllowed(live.paneId)) return null
    const path = this.deps.confine(resolve(dirname(live.path), relative))
    return path ? { kind: 'file', path } : null
  }

  private async receiveOpen(live: Live, request: Request): Promise<Response> {
    const body = await readBoundedBody(request, VIEWER_OPEN_HREF_MAX * 2)
    if (!body) return new Response(null, { status: 400 })
    let href: unknown
    try {
      href = (JSON.parse(new TextDecoder().decode(body)) as { href?: unknown }).href
    } catch {
      return new Response(null, { status: 400 })
    }
    if (typeof href !== 'string' || href.length === 0 || href.length > VIEWER_OPEN_HREF_MAX) {
      return new Response(null, { status: 400 })
    }
    const gesture = this.spendGesture(live)
    if (!gesture) return new Response(null, { status: 403 })
    const target = this.linkTarget(
      live,
      href,
      gesture === 'pointerAt' ? live.pointerShift : live.keyShift,
    )
    if (!target) return new Response(null, { status: 403 })
    this.deps.emit(live.windowId, { type: 'open-link', payload: { paneId: live.paneId, target } })
    return new Response(null, { status: 204 })
  }

  private receiveEditSource(live: Live): Response {
    if (!this.spendGesture(live)) return new Response(null, { status: 403 })
    this.deps.emit(live.windowId, { type: 'edit-source', payload: { paneId: live.paneId } })
    return new Response(null, { status: 204 })
  }

  private extensionFile(live: Live, pathname: string): Response {
    let relative: string
    try {
      relative = decodeURIComponent(pathname).replace(/^\/+/, '')
    } catch {
      return new Response(null, { status: 400 })
    }
    const body = relative ? this.deps.readExtensionFile(live.source.dir, relative) : null
    if (!body) return new Response(null, { status: 404, headers: this.headers(live, 'text/plain') })
    return new Response(new Uint8Array(body), {
      headers: this.headers(live, contentTypeOf(join(live.source.dir, relative))),
    })
  }
}
