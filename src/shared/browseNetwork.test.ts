import { describe, expect, it } from 'vitest'
import { type NetworkRequest, filterRequests, summarizeRequest } from './browseNetwork'

function req(id: string, extra: Partial<NetworkRequest>): NetworkRequest {
  return {
    requestId: id,
    url: `https://x.test/${id}`,
    method: 'GET',
    type: 'Document',
    finished: true,
    ts: 1,
    ...extra,
  }
}

const log = [
  req('1', { url: 'https://x.test/api/users', type: 'XHR', status: 200 }),
  req('2', { url: 'https://x.test/api/cart', type: 'Fetch', method: 'POST', status: 502 }),
  req('3', { url: 'https://cdn.test/app.js', type: 'Script', status: 200 }),
]

describe('filterRequests', () => {
  it('filters by url substring', () => {
    expect(filterRequests(log, { filter: 'api' }).map((r) => r.requestId)).toEqual(['1', '2'])
  })

  it('filters by resource type, case-insensitively and by list', () => {
    expect(filterRequests(log, { types: ['xhr', 'fetch'] }).map((r) => r.requestId)).toEqual([
      '1',
      '2',
    ])
  })

  it('filters by method and status class', () => {
    expect(filterRequests(log, { method: 'post' }).map((r) => r.requestId)).toEqual(['2'])
    expect(filterRequests(log, { status: '5xx' }).map((r) => r.requestId)).toEqual(['2'])
  })
})

describe('summarizeRequest', () => {
  it('drops headers from the list view', () => {
    const summary = summarizeRequest(req('9', { requestHeaders: { a: 'b' } }))
    expect(summary).not.toHaveProperty('requestHeaders')
    expect(summary.requestId).toBe('9')
  })
})
