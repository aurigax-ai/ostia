import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
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
  type ViewerDocumentMeta,
  type ViewerPortableTables,
} from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import type {
  ViewerOpenRequest,
  ViewerOpenResult,
  ViewerStopped,
} from '../../../shared/files/filesApi'
import {
  contentTypeOf,
  extensionOfViewerPartition,
  hardenViewerSession,
  type ViewerSession,
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
  statDocument: (path: string) => Promise<ViewerStat | null>
  readExtensionFile: (dir: string, path: string) => Buffer | null
  watch: (owner: string, path: string) => void
  unwatch: (owner: string, path: string) => void
  locale: () => string
  guests: ViewerWatch
  stopped: (windowId: string, event: ViewerStopped) => void
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
}

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

  constructor(private readonly deps: ViewerHostDeps) {}

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
  }

  changed(owner: string): void {
    if (!owner.startsWith(OWNER_PREFIX)) return
    const live = this.byToken.get(owner.slice(OWNER_PREFIX.length))
    if (!live) return
    const message = encoder.encode(`event: ${VIEWER_CHANGED_EVENT}\ndata: 1\n\n`)
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

  acceptsAttach(partition: string | undefined, src: string | undefined, windowId: string): boolean {
    const extId = extensionOfViewerPartition(partition)
    if (!extId || !src) return false
    const live = this.liveOf(src)
    return Boolean(
      live &&
        live.extId === extId &&
        live.windowId === windowId &&
        src === `${VIEWER_SCHEME}://${live.token}/${live.source.entry}`,
    )
  }

  adopt(guest: ViewerGuest): boolean {
    if (![...this.prepared.values()].includes(guest.session as ViewerSession)) return false
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    guest.on('will-navigate', (event: { preventDefault: () => void }) => event.preventDefault())
    guest.on('will-redirect', (event: { preventDefault: () => void }) => event.preventDefault())
    let token: string | null = null
    guest.on('did-navigate', (_event: unknown, url: string) => {
      const live = typeof url === 'string' ? this.liveOf(url) : null
      if (token) this.deps.guests.unwatch(token)
      token = live?.token ?? null
      if (live) this.watchGuest(live, guest)
    })
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
    if (request.method !== 'GET') return new Response(null, { status: 405 })
    if (pathname === VIEWER_META_PATH) return this.meta(live)
    if (pathname === VIEWER_DOCUMENT_PATH) return this.document(live)
    if (pathname === VIEWER_EVENTS_PATH) return this.events(live)
    return this.extensionFile(live, pathname)
  }

  private async meta(live: Live): Promise<Response> {
    const stat = await this.deps.statDocument(live.path)
    if (!stat) return new Response(null, { status: 404, headers: viewerHeaders('text/plain') })
    const meta: ViewerDocumentMeta = {
      name: live.path.slice(live.path.lastIndexOf('/') + 1),
      size: stat.size,
      modified: stat.modified,
      locale: this.deps.locale(),
      viewType: live.viewType,
    }
    return new Response(JSON.stringify(meta), {
      headers: viewerHeaders('application/json; charset=utf-8'),
    })
  }

  private async document(live: Live): Promise<Response> {
    const read = await this.deps.readDocument(live.path)
    if (read.ok) {
      return new Response(new Uint8Array(read.body), {
        headers: viewerHeaders('application/octet-stream'),
      })
    }
    const size = (await this.deps.statDocument(live.path))?.size
    return new Response(null, {
      status: read.status,
      headers: viewerHeaders('text/plain', size ? { 'x-ostia-size': String(size) } : {}),
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
    return new Response(stream, { headers: viewerHeaders('text/event-stream') })
  }

  private async receivePortable(live: Live, request: Request): Promise<Response> {
    const length = Number(request.headers.get('content-length') ?? '0')
    const text = length > PORTABLE_TABLES_BYTES_MAX ? '' : await request.text().catch(() => '')
    if (length > PORTABLE_TABLES_BYTES_MAX || text.length > PORTABLE_TABLES_BYTES_MAX) {
      live.portable = 'too-large'
      return new Response(null, { status: 413 })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return new Response(null, { status: 400 })
    }
    const tables = portableTables(parsed)
    if (!tables) return new Response(null, { status: 400 })
    live.portable = tables
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
    if (!body) return new Response(null, { status: 404, headers: viewerHeaders('text/plain') })
    return new Response(new Uint8Array(body), {
      headers: viewerHeaders(contentTypeOf(join(live.source.dir, relative))),
    })
  }
}
