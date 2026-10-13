import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  MAX_FAILED_REQUESTS,
  createNetworkTracker,
  requestsFor,
  setGuestRoutes,
  trackNetworkEvent,
  watchGuestNetwork,
} from './guestNetwork'

function sent(t: ReturnType<typeof createNetworkTracker>, id: string, url: string, method = 'GET') {
  trackNetworkEvent(t, 'Network.requestWillBeSent', { requestId: id, request: { url, method } }, 1)
}

describe('trackNetworkEvent', () => {
  it('records an HTTP error response with the request method', () => {
    const t = createNetworkTracker()
    sent(t, '1', 'http://api/cart', 'POST')
    trackNetworkEvent(
      t,
      'Network.responseReceived',
      { requestId: '1', response: { status: 502 } },
      5,
    )
    expect(t.failed).toEqual([{ url: 'http://api/cart', method: 'POST', status: 502, ts: 5 }])
  })

  it('ignores successful responses', () => {
    const t = createNetworkTracker()
    sent(t, '1', 'http://api/ok')
    trackNetworkEvent(
      t,
      'Network.responseReceived',
      { requestId: '1', response: { status: 200 } },
      5,
    )
    trackNetworkEvent(t, 'Network.loadingFinished', { requestId: '1' }, 6)
    expect(t.failed).toEqual([])
    expect(t.pending.size).toBe(0)
  })

  it('records a transport failure with its error text', () => {
    const t = createNetworkTracker()
    sent(t, '2', 'http://cdn/font.woff2')
    trackNetworkEvent(
      t,
      'Network.loadingFailed',
      { requestId: '2', errorText: 'net::ERR_CONNECTION_REFUSED' },
      7,
    )
    expect(t.failed).toEqual([
      { url: 'http://cdn/font.woff2', method: 'GET', error: 'net::ERR_CONNECTION_REFUSED', ts: 7 },
    ])
  })

  it('does not treat a cancelled request as a failure', () => {
    const t = createNetworkTracker()
    sent(t, '3', 'http://x/aborted')
    trackNetworkEvent(t, 'Network.loadingFailed', { requestId: '3', canceled: true }, 7)
    expect(t.failed).toEqual([])
  })

  it('skips data: urls and caps the failure list', () => {
    const t = createNetworkTracker()
    sent(t, 'd', 'data:image/png;base64,AAAA')
    expect(t.pending.size).toBe(0)
    for (let i = 0; i < MAX_FAILED_REQUESTS + 5; i++) {
      sent(t, `r${i}`, `http://x/${i}`)
      trackNetworkEvent(t, 'Network.loadingFailed', { requestId: `r${i}`, errorText: 'e' }, i)
    }
    expect(t.failed).toHaveLength(MAX_FAILED_REQUESTS)
    expect(t.failed[0].url).toBe('http://x/5')
  })
})

describe('requests made before the page side of Network is on', () => {
  const paused = {
    requestId: 'interception-1',
    networkId: '3104501.2',
    resourceType: 'Fetch',
    request: { url: 'http://127.0.0.1/api/ping', method: 'GET', headers: { Accept: '*/*' } },
  }

  it('logs a request seen only as paused, with the status from the extra response info', () => {
    const t = createNetworkTracker()
    trackNetworkEvent(t, 'Fetch.requestPaused', paused, 1)
    trackNetworkEvent(
      t,
      'Network.responseReceivedExtraInfo',
      { requestId: '3104501.2', statusCode: 200, headers: { 'Content-Type': 'text/plain; x=1' } },
      2,
    )
    trackNetworkEvent(t, 'Network.loadingFinished', { requestId: '3104501.2' }, 3)
    expect(t.requests).toEqual([
      {
        requestId: '3104501.2',
        url: 'http://127.0.0.1/api/ping',
        method: 'GET',
        type: 'Fetch',
        finished: true,
        status: 200,
        mimeType: 'text/plain',
        requestHeaders: { Accept: '*/*' },
        responseHeaders: { 'Content-Type': 'text/plain; x=1' },
        ts: 1,
      },
    ])
    expect(t.pending.size).toBe(0)
  })

  it('logs a request once when it is seen both paused and sent, in either order', () => {
    const pausedFirst = createNetworkTracker()
    trackNetworkEvent(pausedFirst, 'Fetch.requestPaused', paused, 1)
    sent(pausedFirst, '3104501.2', 'http://127.0.0.1/api/ping')
    expect(pausedFirst.requests).toHaveLength(1)
    const sentFirst = createNetworkTracker()
    sent(sentFirst, '3104501.2', 'http://127.0.0.1/api/ping')
    trackNetworkEvent(sentFirst, 'Fetch.requestPaused', paused, 2)
    expect(sentFirst.requests).toHaveLength(1)
  })

  it('still logs every hop of a redirect, which reuses the request id', () => {
    const t = createNetworkTracker()
    sent(t, '9', 'http://a/old')
    sent(t, '9', 'http://a/new')
    expect(t.requests.map((r) => r.url)).toEqual(['http://a/old', 'http://a/new'])
  })

  it('keeps the status of the real response over the extra info', () => {
    const t = createNetworkTracker()
    sent(t, '1', 'http://api/x')
    trackNetworkEvent(
      t,
      'Network.responseReceived',
      { requestId: '1', response: { status: 304 } },
      2,
    )
    trackNetworkEvent(
      t,
      'Network.responseReceivedExtraInfo',
      { requestId: '1', statusCode: 200 },
      3,
    )
    expect(t.requests[0].status).toBe(304)
  })
})

describe('watchGuestNetwork', () => {
  function fakeGuest(id: number) {
    const events = new EventEmitter()
    const commands: string[] = []
    const guest = {
      id,
      debugger: {
        isAttached: () => true,
        on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
        sendCommand: (
          method: string,
          params?: { requestId?: string; patterns?: { urlPattern: string }[] },
        ) => {
          const detail = params?.requestId ?? params?.patterns?.map((p) => p.urlPattern).join(',')
          commands.push(detail ? `${method} ${detail}` : method)
          return Promise.resolve({})
        },
      },
    }
    return {
      guest: guest as unknown as Electron.WebContents,
      commands,
      message: (method: string, params: unknown) => events.emit('message', {}, method, params),
    }
  }

  const pausedPing = {
    requestId: 'interception-1',
    networkId: 'n1',
    resourceType: 'Fetch',
    request: { url: 'http://127.0.0.1/api/ping', method: 'GET' },
  }

  it('logs and lets through a request the page made before it announces requests itself', () => {
    const { guest, commands, message } = fakeGuest(7001)
    watchGuestNetwork(guest)
    expect(commands).toEqual(['Fetch.enable *', 'Network.enable'])
    message('Network.requestWillBeSent', {
      requestId: 'doc',
      type: 'Document',
      request: { url: 'http://127.0.0.1/', method: 'GET' },
    })
    message('Fetch.requestPaused', { ...pausedPing, requestId: 'interception-0', networkId: 'doc' })
    message('Fetch.requestPaused', pausedPing)
    expect(commands).toContain('Fetch.continueRequest interception-1')
    expect(commands).not.toContain('Fetch.disable')
    expect(requestsFor(7001).map((r) => r.url)).toEqual([
      'http://127.0.0.1/',
      'http://127.0.0.1/api/ping',
    ])
  })

  it('stops pausing once a request arrives both paused and announced by the page', () => {
    const { guest, commands, message } = fakeGuest(7002)
    watchGuestNetwork(guest)
    message('Fetch.requestPaused', pausedPing)
    expect(commands).not.toContain('Fetch.disable')
    message('Network.requestWillBeSent', {
      requestId: 'n2',
      type: 'Fetch',
      request: { url: 'http://127.0.0.1/api/later', method: 'GET' },
    })
    message('Fetch.requestPaused', { ...pausedPing, requestId: 'interception-2', networkId: 'n2' })
    expect(commands.filter((c) => c === 'Fetch.disable')).toHaveLength(1)
    expect(commands).toContain('Fetch.continueRequest interception-2')
    expect(requestsFor(7002).map((r) => r.url)).toEqual([
      'http://127.0.0.1/api/ping',
      'http://127.0.0.1/api/later',
    ])
  })

  it('keeps a route working while it still pauses everything, and narrows to the route afterwards', async () => {
    const { guest, commands, message } = fakeGuest(7003)
    watchGuestNetwork(guest)
    await setGuestRoutes(guest, ['**/api/blocked'], (paused) =>
      paused.request.url.endsWith('/api/blocked')
        ? { method: 'Fetch.failRequest', params: { requestId: paused.requestId } }
        : null,
    )
    expect(commands.at(-1)).toBe('Fetch.enable *')
    message('Fetch.requestPaused', {
      requestId: 'interception-3',
      networkId: 'n3',
      request: { url: 'http://127.0.0.1/api/blocked', method: 'GET' },
    })
    expect(commands).toContain('Fetch.failRequest interception-3')
    message('Network.requestWillBeSent', {
      requestId: 'n4',
      type: 'Fetch',
      request: { url: 'http://127.0.0.1/api/other', method: 'GET' },
    })
    message('Fetch.requestPaused', {
      requestId: 'interception-4',
      networkId: 'n4',
      request: { url: 'http://127.0.0.1/api/other', method: 'GET' },
    })
    expect(commands).toContain('Fetch.continueRequest interception-4')
    expect(commands).toContain('Fetch.enable **/api/blocked')
    await setGuestRoutes(guest, [], null)
    expect(commands.at(-1)).toBe('Fetch.disable')
  })
})
