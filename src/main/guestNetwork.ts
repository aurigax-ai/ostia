import type { NetworkRequest } from '../shared/browseNetwork'
import type { PickFailedRequest } from '../shared/pick'

export const MAX_FAILED_REQUESTS = 200
export const MAX_LOGGED_REQUESTS = 500
const MAX_PENDING_REQUESTS = 1000

export interface NetworkTracker {
  pending: Map<string, { url: string; method: string }>
  failed: PickFailedRequest[]
  requests: NetworkRequest[]
  lastActivity: number
}

export function createNetworkTracker(): NetworkTracker {
  return { pending: new Map(), failed: [], requests: [], lastActivity: 0 }
}

function headerRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = String(v)
  return out
}

function logged(tracker: NetworkTracker, id: string): NetworkRequest | undefined {
  for (let i = tracker.requests.length - 1; i >= 0; i--) {
    if (tracker.requests[i].requestId === id) return tracker.requests[i]
  }
  return undefined
}

function logRequest(tracker: NetworkTracker, entry: NetworkRequest): void {
  tracker.requests.push(entry)
  if (tracker.requests.length > MAX_LOGGED_REQUESTS) {
    tracker.requests.splice(0, tracker.requests.length - MAX_LOGGED_REQUESTS)
  }
}

function record(tracker: NetworkTracker, entry: PickFailedRequest): void {
  tracker.failed.push(entry)
  if (tracker.failed.length > MAX_FAILED_REQUESTS) {
    tracker.failed.splice(0, tracker.failed.length - MAX_FAILED_REQUESTS)
  }
}

export function trackNetworkEvent(
  tracker: NetworkTracker,
  method: string,
  params: unknown,
  now: number,
): void {
  const p = (params ?? {}) as {
    requestId?: string
    request?: { url?: string; method?: string; headers?: unknown }
    response?: { url?: string; status?: number; mimeType?: string; headers?: unknown }
    type?: string
    errorText?: string
    canceled?: boolean
  }
  const id = p.requestId
  if (!id) return
  if (method.startsWith('Network.')) tracker.lastActivity = now
  switch (method) {
    case 'Network.requestWillBeSent': {
      const url = p.request?.url ?? ''
      if (url.startsWith('data:')) return
      tracker.pending.set(id, { url, method: p.request?.method ?? 'GET' })
      logRequest(tracker, {
        requestId: id,
        url,
        method: p.request?.method ?? 'GET',
        type: p.type ?? 'Other',
        finished: false,
        requestHeaders: headerRecord(p.request?.headers),
        ts: now,
      })
      if (tracker.pending.size > MAX_PENDING_REQUESTS) {
        const oldest = tracker.pending.keys().next().value
        if (oldest !== undefined) tracker.pending.delete(oldest)
      }
      return
    }
    case 'Network.responseReceived': {
      const status = p.response?.status ?? 0
      const req = tracker.pending.get(id)
      const entry = logged(tracker, id)
      if (entry) {
        entry.status = status
        entry.mimeType = p.response?.mimeType
        entry.responseHeaders = headerRecord(p.response?.headers)
      }
      if (status >= 400) {
        record(tracker, {
          url: req?.url ?? p.response?.url ?? '',
          method: req?.method ?? 'GET',
          status,
          ts: now,
        })
      }
      return
    }
    case 'Network.loadingFailed': {
      const req = tracker.pending.get(id)
      tracker.pending.delete(id)
      const entry = logged(tracker, id)
      if (entry) {
        entry.finished = true
        entry.error = p.canceled ? 'canceled' : (p.errorText ?? 'failed')
      }
      if (!req || p.canceled) return
      record(tracker, { url: req.url, method: req.method, error: p.errorText ?? 'failed', ts: now })
      return
    }
    case 'Network.loadingFinished': {
      tracker.pending.delete(id)
      const entry = logged(tracker, id)
      if (entry) entry.finished = true
      return
    }
  }
}

const trackers = new Map<number, NetworkTracker>()

export function failedRequestsFor(wcId: number): PickFailedRequest[] {
  return trackers.get(wcId)?.failed ?? []
}

export function requestsFor(wcId: number): NetworkRequest[] {
  return trackers.get(wcId)?.requests ?? []
}

export function clearRequestLog(wcId: number): void {
  const tracker = trackers.get(wcId)
  if (tracker) tracker.requests = []
}

export function networkIdleFor(wcId: number, now: number, quietMs: number): boolean {
  const tracker = trackers.get(wcId)
  if (!tracker) return true
  return tracker.pending.size === 0 && now - tracker.lastActivity >= quietMs
}

export function clearGuestNetwork(wcId: number): void {
  trackers.delete(wcId)
}

const watched = new WeakSet<Electron.WebContents>()

export function watchGuestNetwork(guest: Electron.WebContents): void {
  if (watched.has(guest) || !guest.debugger.isAttached()) return
  watched.add(guest)
  const wcId = guest.id
  guest.debugger.on('message', (_e, method, params) => {
    let tracker = trackers.get(wcId)
    if (!tracker) {
      tracker = createNetworkTracker()
      trackers.set(wcId, tracker)
    }
    trackNetworkEvent(tracker, method, params, Date.now())
  })
  guest.debugger.sendCommand('Network.enable').catch(() => {})
}
