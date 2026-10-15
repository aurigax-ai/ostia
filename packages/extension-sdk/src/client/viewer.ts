import {
  VIEWER_CHANGED_EVENT,
  VIEWER_DOCUMENT_PATH,
  VIEWER_EVENTS_PATH,
  VIEWER_META_PATH,
  VIEWER_PORTABLE_PATH,
  type ViewerDocumentMeta,
  type ViewerPortableTables,
} from '../contract/fileViewers'

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
