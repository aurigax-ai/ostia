import { EventEmitter } from 'node:events'
import {
  encodeViewerSelection,
  type ViewerSelectionMeta,
} from '@aurigax-ai/ostia-extension-sdk/contract/viewerSelection'
import type { ClipboardCapture } from '../../../shared/keyboard/clipboardCapture'
import { type ViewerEvent, type ViewerGuest, ViewerHost, type ViewerHostDeps } from './viewerHost'
import type { ViewerSession } from './viewerSessions'
import { ViewerWatch } from './viewerWatch'

export interface FakeSession extends ViewerSession {
  handler: ((request: Request) => Promise<Response>) | null
  filter: ((details: { url: string }, cb: (r: { cancel: boolean }) => void) => void) | null
  permission: ((wc: unknown, permission: string, cb: (granted: boolean) => void) => void) | null
}

export function fakeSession(): FakeSession {
  const session: FakeSession = {
    handler: null,
    filter: null,
    permission: null,
    protocol: {
      handle: (_scheme, handler) => {
        session.handler = handler
      },
    },
    webRequest: {
      onBeforeRequest: (listener) => {
        session.filter = listener
      },
    },
    setProxy: async () => {},
    setPermissionRequestHandler: (handler) => {
      session.permission = handler
    },
    setPermissionCheckHandler: () => {},
    on: () => {},
  }
  return session
}

export const FILE = '/home/u/report.xlsx'
export const BYTES = Buffer.from([1, 2, 3, 4])

export function setup(overrides: Partial<ViewerHostDeps> = {}) {
  const sessions = new Map<string, FakeSession>()
  const watched: string[] = []
  const unwatched: string[] = []
  const stopped: unknown[] = []
  const killed: number[] = []
  const memory = { bytes: 0 }
  const events: Array<ViewerEvent & { windowId: string }> = []
  const clipboard: ClipboardCapture[] = []
  const clock = { now: 1_000_000 }
  let tokens = 0
  let enabled = true
  const deps: ViewerHostDeps = {
    sessionOf: (partition) => {
      const session = sessions.get(partition) ?? fakeSession()
      sessions.set(partition, session)
      return session
    },
    confine: (path) => (path.startsWith('/home/u/') ? path : null),
    ownsPane: (windowId, paneId) => windowId === 'w1' && paneId === 'p1',
    viewer: (extId, viewType, path) =>
      enabled && extId === 'office' && viewType === 'office.spreadsheet' && path.endsWith('.xlsx')
        ? { dir: '/ext/office', entry: 'sheet.html' }
        : null,
    readDocument: async (path) =>
      path === FILE ? { ok: true, body: BYTES } : { ok: false, status: 413 },
    readRange: async () => null,
    statDocument: async (path) => (path.startsWith('/home/u/') ? { size: 4, modified: 7 } : null),
    readExtensionFile: (_dir, path) => (path === 'sheet.html' ? Buffer.from('<html>') : null),
    watch: (owner, path) => {
      watched.push(`${owner} ${path}`)
    },
    unwatch: (owner, path) => {
      unwatched.push(`${owner} ${path}`)
    },
    locale: () => 'zh-Hant',
    guests: new ViewerWatch({
      processes: () => [{ pid: 9, memoryBytes: memory.bytes, cpuPercent: 0 }],
      kill: (pid) => {
        killed.push(pid)
      },
    }),
    stopped: (windowId, event) => {
      stopped.push({ windowId, ...event })
    },
    emit: (windowId, event) => {
      events.push({ windowId, ...event })
    },
    writeClipboard: async (copied) => {
      clipboard.push(copied)
    },
    copyStrings: () => ({
      cells: 'cells {range} {rows}x{columns}',
      image: 'img',
      nothing: 'none',
      text: 'txt',
      textAndImage: 'both',
    }),
    fileLinksAllowed: () => true,
    now: () => clock.now,
    token: () => `t${++tokens}`,
    ...overrides,
  }
  const host = new ViewerHost(deps)
  const disable = (): void => {
    enabled = false
  }
  return {
    host,
    deps,
    sessions,
    watched,
    unwatched,
    stopped,
    killed,
    memory,
    disable,
    events,
    clipboard,
    clock,
  }
}

export const OPEN = { workspaceId: 'ws', paneId: 'p1', path: FILE, viewType: 'office.spreadsheet' }

export function get(
  session: FakeSession | undefined,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  if (!session?.handler) throw new Error('no handler')
  return session.handler(new Request(url, init))
}

export function pngOf(width: number, height: number, extra = 0): Uint8Array {
  const png = new Uint8Array(33 + extra)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(png.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return png
}

export async function selectionBody(
  meta: unknown,
  png: Uint8Array | null = null,
): Promise<Uint8Array> {
  const blob = encodeViewerSelection(meta as ViewerSelectionMeta, png as BlobPart | null)
  return new Uint8Array(await blob.arrayBuffer())
}

export const FRAME = { width: 800, height: 600 }
export const RECT = { x: 10, y: 20, width: 100, height: 40 }

export function postSelection(
  session: FakeSession | undefined,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  return get(session, 'ostia-viewer://t1/~selection', {
    method: 'POST',
    body: Buffer.from(body),
    headers,
  })
}

export function adoptGuest(host: ViewerHost, session: FakeSession | undefined, src: string) {
  const guest = Object.assign(new EventEmitter(), {
    session,
    setWindowOpenHandler: () => {},
    setWebRTCIPHandlingPolicy: () => {},
    isDestroyed: () => false,
    getOSProcessId: () => 9,
    executeJavaScript: () => Promise.resolve(0),
    getURL: () => src,
  })
  host.adopt(guest as unknown as ViewerGuest)
  guest.emit('did-navigate', {}, src)
  return guest
}
