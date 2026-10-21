import { type LocaleCatalogs, type Translate, translatorFor } from '../contract/extensionLocales'
import {
  VIEWER_CHANGED_EVENT,
  VIEWER_DOCUMENT_PATH,
  VIEWER_EVENTS_PATH,
  VIEWER_META_PATH,
  VIEWER_PORTABLE_PATH,
  VIEWER_SELECTION_CLEARED_EVENT,
  type ViewerDocumentMeta,
  type ViewerPortableTables,
} from '../contract/fileKinds'
import { watchScrolling } from '../contract/scrollbar'
import {
  encodeViewerSelection,
  VIEWER_EDIT_SOURCE_PATH,
  VIEWER_OPEN_PATH,
  VIEWER_SELECTION_PATH,
  type ViewerRect,
  type ViewerSelectionCapture,
} from '../contract/viewerSelection'

if (typeof document !== 'undefined') watchScrolling(document)

export type ViewerDocumentProblem = 'too-large' | 'gone' | 'unreadable'

export class ViewerDocumentError extends Error {
  constructor(
    readonly problem: ViewerDocumentProblem,
    readonly size?: number,
  ) {
    super(problem)
  }
}

export interface ViewerDocument extends ViewerDocumentMeta {
  bytes: () => Promise<Uint8Array>
  onDidChange: (listener: () => void) => () => void
}

function problemOf(status: number): ViewerDocumentProblem {
  if (status === 413) return 'too-large'
  return status === 404 || status === 410 ? 'gone' : 'unreadable'
}

export async function openViewerDocument(): Promise<ViewerDocument> {
  const res = await fetch(VIEWER_META_PATH, { cache: 'no-store' })
  if (!res.ok) throw new ViewerDocumentError(problemOf(res.status))
  const meta = (await res.json()) as ViewerDocumentMeta
  return {
    ...meta,
    bytes: async () => {
      const body = await fetch(VIEWER_DOCUMENT_PATH, { cache: 'no-store' })
      if (body.ok) return new Uint8Array(await body.arrayBuffer())
      const size = Number(body.headers.get('x-ostia-size'))
      throw new ViewerDocumentError(
        problemOf(body.status),
        Number.isFinite(size) && size > 0 ? size : undefined,
      )
    },
    onDidChange: (listener) => {
      const events = new EventSource(VIEWER_EVENTS_PATH)
      events.addEventListener(VIEWER_CHANGED_EVENT, () => listener())
      return () => events.close()
    },
  }
}

export async function publishPortable(tables: ViewerPortableTables): Promise<boolean> {
  try {
    const res = await fetch(VIEWER_PORTABLE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tables),
    })
    return res.ok
  } catch {
    return false
  }
}

export type WorkerOutcome<T> = { ok: true; value: T } | { ok: false; problem: 'timeout' | 'failed' }

export function runWorker<T>(
  script: string,
  message: unknown,
  transfer: Transferable[],
  timeoutMs: number,
): Promise<WorkerOutcome<T>> {
  return new Promise((resolve) => {
    const worker = new Worker(script)
    const finish = (outcome: WorkerOutcome<T>): void => {
      clearTimeout(timer)
      worker.terminate()
      resolve(outcome)
    }
    const timer = setTimeout(() => finish({ ok: false, problem: 'timeout' }), timeoutMs)
    worker.onmessage = (event: MessageEvent<T>) => finish({ ok: true, value: event.data })
    worker.onerror = () => finish({ ok: false, problem: 'failed' })
    worker.postMessage(message, transfer)
  })
}

export function showViewerMessage(root: HTMLElement, text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'ostia-viewer-message'
  el.textContent = text
  root.replaceChildren(el)
  return el
}

export function formatMegabytes(bytes: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'megabyte',
    maximumFractionDigits: 1,
  }).format(bytes / 1e6)
}

export interface LoadedViewerBytes {
  doc: ViewerDocument
  t: Translate
  bytes: ArrayBuffer
}

export async function loadViewerBytes(options: {
  root: HTMLElement
  catalogs: LocaleCatalogs
  tooLarge?: (t: Translate, size: number, locale: string) => string
}): Promise<LoadedViewerBytes | null> {
  const { root, catalogs } = options
  const doc = await openViewerDocument().catch(() => null)
  const t = translatorFor(catalogs, doc?.locale ?? 'en')
  if (!doc) {
    showViewerMessage(root, t('unreadable'))
    return null
  }
  doc.onDidChange(() => location.reload())
  showViewerMessage(root, t('loading'))
  try {
    const bytes = await doc.bytes()
    return { doc, t, bytes: bytes.slice().buffer }
  } catch (error) {
    const problem = error instanceof ViewerDocumentError ? error.problem : 'unreadable'
    const size = error instanceof ViewerDocumentError ? (error.size ?? 0) : 0
    const tooLarge =
      options.tooLarge ??
      ((tr: Translate, bytes: number, locale: string) =>
        tr('tooLarge', { size: formatMegabytes(bytes, locale) }))
    showViewerMessage(root, problem === 'too-large' ? tooLarge(t, size, doc.locale) : t(problem))
    return null
  }
}

export function serveWorker<Request>(handle: (request: Request) => unknown): void {
  const scope = self as unknown as {
    onmessage: ((event: MessageEvent<Request>) => void) | null
    postMessage: (message: unknown) => void
  }
  scope.onmessage = (event) => {
    void Promise.resolve(handle(event.data)).then((reply) => scope.postMessage(reply))
  }
}

export interface ViewerSelection {
  capture: ViewerSelectionCapture
  rect: ViewerRect
  text?: string
  html?: string
  csv?: string
  png?: Blob | Uint8Array
}

const selectionListeners = new Set<(published: boolean) => void>()
let selectionPublished = false

function setSelectionPublished(published: boolean): void {
  if (published === selectionPublished) return
  selectionPublished = published
  for (const listener of selectionListeners) listener(published)
}

export function hasPublishedSelection(): boolean {
  return selectionPublished
}

export function onSelectionPublished(listener: (published: boolean) => void): () => void {
  selectionListeners.add(listener)
  return () => selectionListeners.delete(listener)
}

let clearedEvents: EventSource | null = null

function listenForClearedSelection(): void {
  if (clearedEvents) return
  clearedEvents = new EventSource(VIEWER_EVENTS_PATH)
  clearedEvents.addEventListener(VIEWER_SELECTION_CLEARED_EVENT, () => setSelectionPublished(false))
}

export async function publishSelection(selection: ViewerSelection): Promise<boolean> {
  listenForClearedSelection()
  const { png, rect, capture, text, html, csv } = selection
  const body = encodeViewerSelection(
    {
      capture,
      rect,
      frame: { width: window.innerWidth, height: window.innerHeight },
      ...(text === undefined ? {} : { text }),
      ...(html === undefined ? {} : { html }),
      ...(csv === undefined ? {} : { csv }),
    },
    (png as BlobPart | undefined) ?? null,
  )
  try {
    const res = await fetch(VIEWER_SELECTION_PATH, { method: 'POST', body })
    setSelectionPublished(res.ok)
    return res.ok
  } catch {
    setSelectionPublished(false)
    return false
  }
}

export async function clearSelection(): Promise<void> {
  setSelectionPublished(false)
  try {
    await fetch(VIEWER_SELECTION_PATH, { method: 'DELETE' })
  } catch {}
}

async function postGesture(path: string, body?: unknown): Promise<boolean> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return res.ok
  } catch {
    return false
  }
}

export function openViewerLink(href: string): Promise<boolean> {
  return postGesture(VIEWER_OPEN_PATH, { href })
}

export function requestEditSource(): Promise<boolean> {
  return postGesture(VIEWER_EDIT_SOURCE_PATH)
}

export function viewerDocumentUrl(): string {
  return new URL(VIEWER_DOCUMENT_PATH, location.href).href
}
