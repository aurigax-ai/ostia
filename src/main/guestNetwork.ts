import type { PickFailedRequest } from '../shared/pick'

export const MAX_FAILED_REQUESTS = 200
const MAX_PENDING_REQUESTS = 1000

export interface NetworkTracker {
  pending: Map<string, { url: string; method: string }>
  failed: PickFailedRequest[]
}

export function createNetworkTracker(): NetworkTracker {
  return { pending: new Map(), failed: [] }
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
    request?: { url?: string; method?: string }
    response?: { url?: string; status?: number }
    errorText?: string
    canceled?: boolean
  }
  const id = p.requestId
  if (!id) return
  switch (method) {
    case 'Network.requestWillBeSent': {
      const url = p.request?.url ?? ''
      if (url.startsWith('data:')) return
      tracker.pending.set(id, { url, method: p.request?.method ?? 'GET' })
      if (tracker.pending.size > MAX_PENDING_REQUESTS) {
        const oldest = tracker.pending.keys().next().value
        if (oldest !== undefined) tracker.pending.delete(oldest)
      }
      return
    }
    case 'Network.responseReceived': {
      const status = p.response?.status ?? 0
      const req = tracker.pending.get(id)
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
      if (!req || p.canceled) return
      record(tracker, { url: req.url, method: req.method, error: p.errorText ?? 'failed', ts: now })
      return
    }
    case 'Network.loadingFinished':
      tracker.pending.delete(id)
      return
  }
}

const trackers = new Map<number, NetworkTracker>()

export function failedRequestsFor(wcId: number): PickFailedRequest[] {
  return trackers.get(wcId)?.failed ?? []
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
