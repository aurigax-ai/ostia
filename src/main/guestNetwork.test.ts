import { describe, expect, it } from 'vitest'
import { MAX_FAILED_REQUESTS, createNetworkTracker, trackNetworkEvent } from './guestNetwork'

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
