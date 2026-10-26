import { describe, expect, it, vi } from 'vitest'
import type { ServerClient } from './serverClient'
import { serverRoutes } from './serverRoutes'

function routes() {
  const request = vi.fn(async () => ({}))
  return { request, routes: serverRoutes({ request } as unknown as ServerClient) }
}

describe('routes that must not be retried on a rate limit', () => {
  it('SYA-C150 asks once to replace the key, with the version read in If-Match and the signed headers', async () => {
    const { request, routes: r } = routes()
    await r.rotate('token', '{"manifest":"m"}', '3', { 'X-Device-Signature': 'sig' })
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/v1/sync/rotate',
      expect.objectContaining({
        json: '{"manifest":"m"}',
        headers: { 'If-Match': '3', 'X-Device-Signature': 'sig' },
        retryRateLimited: false,
      }),
    )
  })

  it('SYA-C151 asks once to clean up, with the manifest version in If-Match and the signed headers', async () => {
    const { request, routes: r } = routes()
    await r.gc('token', '{"keep":["a"]}', '4', { 'X-Device-Signature': 'sig' })
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/v1/sync/gc',
      expect.objectContaining({
        json: '{"keep":["a"]}',
        headers: { 'If-Match': '4', 'X-Device-Signature': 'sig' },
        retryRateLimited: false,
      }),
    )
  })

  it('SYA-C152 checks in once without retrying a rate limit', async () => {
    const { request, routes: r } = routes()
    await r.heartbeat('token')
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/v1/devices/heartbeat',
      expect.objectContaining({ retryRateLimited: false }),
    )
  })
})
